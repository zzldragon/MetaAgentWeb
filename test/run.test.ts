// Running a generated agent — mostly a test that it REFUSES to.
//
// This is the one place the server executes what it produced, so the valuable assertions
// are the negative ones: off by default, off when bound beyond loopback even with the
// flag set, and never leaking the key it was given. A feature this shape is judged by
// what it declines to do.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

process.env.MTA_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "mtaweb-run-"));

const { createApp } = await import("../src/app.ts");
const { CONFIG } = await import("../src/config.ts");
const runner = await import("../src/run.ts");

const app = createApp({ quiet: true });
let base = "";

const api = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(base + url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* SSE is not JSON */ }
  return { status: res.status, json, text };
};

/** CONFIG is frozen-ish at import; flip a field for one test and put it back. */
function withConfig<T>(patch: Record<string, unknown>, fn: () => T): T {
  const saved: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    saved[k] = (CONFIG as any)[k];
    (CONFIG as any)[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) (CONFIG as any)[k] = v;
  }
}

before(async () => {
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const addr = app.server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await app.close();
  fs.rmSync(process.env.MTA_DATA!, { recursive: true, force: true });
});

describe("the run gate", () => {
  it("is closed unless MTA_ALLOW_RUN is set", () => {
    const verdict = withConfig({ allowRun: false }, () => runner.allowed());
    assert.equal(verdict.ok, false);
    assert.match((verdict as { reason: string }).reason, /MTA_ALLOW_RUN=1/);
  });

  it("stays closed off loopback EVEN WITH the flag set", () => {
    // The condition that matters. A flag someone set once and forgot is not a control;
    // this one stops working the moment the threat model changes.
    const verdict = withConfig({ allowRun: true, host: "0.0.0.0" }, () => runner.allowed());
    assert.equal(verdict.ok, false);
    assert.match((verdict as { reason: string }).reason, /loopback/);
    assert.match((verdict as { reason: string }).reason, /does not override/);
  });

  it("opens only with both conditions met", () => {
    const verdict = withConfig({ allowRun: true, host: "127.0.0.1" },
                               () => runner.allowed());
    assert.equal(verdict.ok, true);
  });

  it("reports its state to the browser so the UI can explain itself", async () => {
    const { status, json } = await api("GET", "/api/run-status");
    assert.equal(status, 200);
    assert.equal(json.enabled, false, "running should be off in a default test run");
    assert.match(json.reason, /MTA_ALLOW_RUN/);
  });

  it("refuses a run request with 403 and a reason, not a crash", async () => {
    const { status, json } = await api(
      "POST", `/api/jobs/${crypto.randomUUID()}/run`, { task: "hello" });
    assert.equal(status, 403);
    assert.match(json.error, /disabled|loopback/);
  });

  it("checks the gate BEFORE the job, so a disabled server says why", async () => {
    // Order matters: reporting "no such job" for an unknown id would tell someone
    // probing that the feature exists and is merely missing their job.
    const { status } = await api("POST", `/api/jobs/${crypto.randomUUID()}/run`,
                                 { task: "hello" });
    assert.equal(status, 403, "the gate must be checked first");
  });
});

describe("run ownership", () => {
  it("404s an unknown or malformed run id", async () => {
    assert.equal((await api("GET", `/api/runs/${crypto.randomUUID()}`)).status, 404);
    assert.equal((await api("GET", "/api/runs/not-an-id")).status, 404);
    assert.equal((await api("DELETE", `/api/runs/${crypto.randomUUID()}`)).status, 404);
    assert.equal((await api("GET", `/api/runs/${crypto.randomUUID()}/stream`)).status, 404);
  });
});

describe("the key never escapes the child process", () => {
  // A KEY, not the string "sk-". The generated agent contains MetaAgent's own secret
  // scanner -- `r"sk-[A-Za-z0-9]{20,}"` -- so a prefix match flags the detector that
  // exists to catch leaks. Matching the key SHAPE skips it: after `sk-` comes `[`.
  const KEY = /sk-[A-Za-z0-9]{20,}/;

  it("is not in the run record the browser receives", () => {
    const blob = JSON.stringify(runner.get(crypto.randomUUID()) ?? {});
    assert.doesNotMatch(blob, KEY, "a credential appeared in a run record");
  });

  it("is not written into the job directory", async () => {
    // The whole reason the key travels as AGENT_API_KEY in the child's environment:
    // anything written to the job dir ends up in the download.
    const graph = {
      nodes: [
        { id: "a1", kind: "agent", name: "solo", x: 0, y: 0, props: { role: "single" } },
        { id: "l1", kind: "llm", name: "m", x: 200, y: 0,
          props: { provider: "siliconflow", model: "m", api_key: "",
                   base_url: "http://localhost" } }],
      edges: [{ src: "l1", dst: "a1", props: {} }],
      state_schema: [], storage: {},
    };
    const queued = await api("POST", "/api/generate", { graph, name: "KeyCheck" });
    for (;;) {
      const job = await api("GET", `/api/jobs/${queued.json.jobId}`);
      if (["done", "failed"].includes(job.json.state)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const dir = path.join(CONFIG.dataDir, "jobs", queued.json.jobId);
    const found: string[] = [];
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        try {
          if (KEY.test(fs.readFileSync(full, "utf-8"))) found.push(entry.name);
        } catch { /* binary */ }
      }
    };
    walk(dir);
    assert.deepEqual(found, [], "a credential was written into the job directory");
  });
});
