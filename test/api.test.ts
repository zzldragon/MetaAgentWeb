// The API, driven over a real socket.
//
// These are not unit tests of the handlers. The things worth checking here are the ones
// that only exist once a request has actually travelled: status codes, ownership
// refusals, the queue admitting or turning work away, and the Python bridge returning
// something the server understood.
//
// Every run gets its own MTA_DATA, so tests never see each other's graphs or jobs — and
// so a failing run leaves its evidence behind in a temp directory rather than in yours.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

process.env.MTA_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "mtaweb-test-"));
process.env.MTA_HOST = "127.0.0.1";
process.env.MTA_PORT = "0";                       // ephemeral: parallel runs cannot clash

const { createApp } = await import("../src/app.ts");
const { CONFIG } = await import("../src/config.ts");

const app = createApp({ quiet: true });
let base = "";

/** The smallest valid graph: one agent, one LLM. */
const minimalGraph = (apiKey = "") => ({
  nodes: [
    { id: "a1", kind: "agent", name: "solo", x: 0, y: 0, props: { role: "single" } },
    { id: "l1", kind: "llm", name: "m", x: 200, y: 0,
      props: { provider: "siliconflow", model: "deepseek-ai/DeepSeek-V4-Flash",
               api_key: apiKey, base_url: "https://api.siliconflow.cn/v1" } },
  ],
  edges: [{ src: "l1", dst: "a1", props: {} }],
  state_schema: [], storage: {},
});

const api = async (method: string, url: string, body?: unknown, raw?: Buffer) => {
  const init: RequestInit = { method };
  if (raw) {
    init.body = raw as unknown as BodyInit;
    init.headers = { "content-type": "application/octet-stream" };
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const res = await fetch(base + url, init);
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* a download is not JSON */ }
  return { status: res.status, json, text, res };
};

/** Poll a job to a terminal state. Generation takes seconds, so this waits. */
async function settle(jobId: string, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { json } = await api("GET", `/api/jobs/${jobId}`);
    if (["done", "failed", "cancelled"].includes(json.state)) return json;
    if (Date.now() > deadline) throw new Error(`job ${jobId} stuck in ${json.state}`);
    await new Promise((r) => setTimeout(r, 250));
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

describe("schema", () => {
  it("serves the node registry from MetaAgent", async () => {
    const { status, json } = await api("GET", "/api/schema");
    assert.equal(status, 200);
    assert.equal(Object.keys(json.kinds).length, 33);
    assert.ok(json.allowed_edges.length > 400);
    assert.equal(json.palette.length, 5);
  });

  it("caches it — the registries cannot change while the server runs", async () => {
    const started = Date.now();
    await api("GET", "/api/schema");
    assert.ok(Date.now() - started < 500, "a cached schema should not spawn Python");
  });
});

describe("graphs", () => {
  it("creates, reads, lists, updates and deletes", async () => {
    const created = await api("POST", "/api/graphs",
                              { name: "First", graph: minimalGraph() });
    assert.equal(created.status, 201);
    const id = created.json.id;
    assert.match(id, /^[0-9a-f-]{36}$/, "ids must be opaque, not names or counters");

    const read = await api("GET", `/api/graphs/${id}`);
    assert.equal(read.status, 200);
    assert.equal(read.json.name, "First");
    assert.equal(read.json.graph.nodes.length, 2);

    const listed = await api("GET", "/api/graphs");
    assert.ok(listed.json.graphs.some((g: any) => g.id === id));

    const updated = await api("PUT", `/api/graphs/${id}`,
                              { name: "Renamed", graph: minimalGraph() });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.name, "Renamed");

    assert.equal((await api("DELETE", `/api/graphs/${id}`)).status, 200);
    assert.equal((await api("GET", `/api/graphs/${id}`)).status, 404);
  });

  it("404s an id that is not a well-formed opaque id", async () => {
    // Not a 500: a malformed id is a client mistake, and it must never reach the disk.
    for (const bad of ["nope", "../../etc/passwd", "..%2f..%2fconfig.json"]) {
      const { status } = await api("GET", `/api/graphs/${encodeURIComponent(bad)}`);
      assert.equal(status, 404, bad);
    }
  });

  it("rejects a body with no graph", async () => {
    assert.equal((await api("POST", "/api/graphs", { name: "x" })).status, 400);
  });
});

describe("uploading a .mta", () => {
  const SCOUT = path.join(CONFIG.metaagent, "graphs", "xCodeScoutAgent.mta");

  it("accepts a real bundle and stores its graph", async (t) => {
    if (!fs.existsSync(SCOUT)) return t.skip("no sample .mta in this MetaAgent checkout");
    const bytes = fs.readFileSync(SCOUT);
    const { status, json } = await api("POST", "/api/mta?name=Scout", undefined, bytes);
    assert.equal(status, 201);
    assert.equal(json.name, "Scout");
    assert.equal(json.hasSource, true);
    assert.equal(json.report.mode, "autonomous");
    assert.equal(json.report.tools_restored.length, 6);

    // the graph itself came back out of the bundle, not just its validation report
    const read = await api("GET", `/api/graphs/${json.id}`);
    assert.equal(read.status, 200);
    assert.ok(read.json.graph.nodes.length >= 7);
  });

  it("hands back the original bundle for download", async (t) => {
    if (!fs.existsSync(SCOUT)) return t.skip("no sample .mta");
    const bytes = fs.readFileSync(SCOUT);
    const { json } = await api("POST", "/api/mta?name=RoundTrip", undefined, bytes);
    const dl = await fetch(`${base}/api/graphs/${json.id}/mta`);
    assert.equal(dl.status, 200);
    const back = Buffer.from(await dl.arrayBuffer());
    // Byte-identical: the upload is kept as-is, not re-zipped from the parsed graph --
    // a re-zip would silently drop anything the server did not model.
    assert.deepEqual(back, bytes);
  });

  it("404s a bundle download for a graph that was never uploaded", async () => {
    const created = await api("POST", "/api/graphs",
                              { name: "TypedIn", graph: minimalGraph() });
    const { status } = await api("GET", `/api/graphs/${created.json.id}/mta`);
    assert.equal(status, 404);
  });

  it("rejects a file that is not a .mta", async () => {
    const { status, json } = await api("POST", "/api/mta?name=Junk", undefined,
                                       Buffer.from("this is not a zip"));
    assert.equal(status, 400);
    assert.match(json.error, /graph\.json|did not validate/);
  });

  it("rejects an empty upload", async () => {
    const { status } = await api("POST", "/api/mta", undefined, Buffer.alloc(0));
    assert.ok([400, 411].includes(status), `got ${status}`);
  });

  it("leaves no scratch directory behind", async (t) => {
    if (!fs.existsSync(SCOUT)) return t.skip("no sample .mta");
    await api("POST", "/api/mta?name=Tidy", undefined, fs.readFileSync(SCOUT));
    const uploads = path.join(CONFIG.dataDir, "uploads");
    const left = fs.existsSync(uploads) ? fs.readdirSync(uploads) : [];
    assert.deepEqual(left, [], "the upload scratch dir must not survive the request");
  });
});

describe("analyze", () => {
  it("reports the mode and entry of a valid graph", async () => {
    const { status, json } = await api("POST", "/api/analyze", { graph: minimalGraph() });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.mode, "chain");
    assert.deepEqual(json.errors, []);
  });

  it("returns validation errors as data, not as a failure", async () => {
    const graph = minimalGraph();
    graph.nodes.push({ id: "a2", kind: "agent", name: "second", x: 0, y: 200,
                       props: { role: "single" } } as any);
    const { status, json } = await api("POST", "/api/analyze", { graph });
    assert.equal(status, 200, "a graph that fails to validate is still a valid request");
    assert.equal(json.ok, false);
    assert.ok(json.errors.length > 0);
  });

  it("leaves no scratch directory behind", async () => {
    await api("POST", "/api/analyze", { graph: minimalGraph() });
    const uploads = path.join(CONFIG.dataDir, "uploads");
    const left = fs.existsSync(uploads) ? fs.readdirSync(uploads) : [];
    assert.deepEqual(left, [], "analyze must clean up after itself");
  });
});

describe("generate", () => {
  it("queues a job and produces a downloadable zip", async () => {
    const queued = await api("POST", "/api/generate",
                             { graph: minimalGraph(), name: "Demo" });
    assert.equal(queued.status, 202);
    assert.equal(queued.json.state, "queued");

    const job = await settle(queued.json.jobId);
    assert.equal(job.state, "done", job.error);
    assert.equal(job.result.ok, true);
    assert.equal(job.result.hasDownload, true);
    assert.ok(job.result.files.some((f: any) => f.path === "agent.py"));
    assert.ok(job.result.propsDefaulted > 50, "a partial graph should be completed");

    const dl = await api("GET", `/api/jobs/${queued.json.jobId}/download`);
    assert.equal(dl.status, 200);
    assert.match(dl.res.headers.get("content-disposition") ?? "", /Demo\.zip/);
    assert.ok(Number(dl.res.headers.get("content-length")) > 1000);
  });

  it("never leaks a filesystem path to the client", async () => {
    // The result carries out_dir and zip internally; publicJob must not pass them on.
    const queued = await api("POST", "/api/generate",
                             { graph: minimalGraph(), name: "Paths" });
    const job = await settle(queued.json.jobId);
    const blob = JSON.stringify(job);
    assert.ok(!blob.includes(CONFIG.dataDir), "a data path reached the client");
    assert.equal(job.result.out_dir, undefined);
    assert.equal(job.result.zip, undefined);
  });

  it("generates from a stored graph by id", async () => {
    const created = await api("POST", "/api/graphs",
                              { name: "Stored", graph: minimalGraph() });
    const queued = await api("POST", "/api/generate",
                             { graphId: created.json.id, name: "FromStore" });
    assert.equal(queued.status, 202);
    const job = await settle(queued.json.jobId);
    assert.equal(job.state, "done", job.error);
    assert.equal(job.result.name, "FromStore");
  });

  it("404s a graphId that does not exist", async () => {
    const { status } = await api("POST", "/api/generate",
                                 { graphId: crypto.randomUUID() });
    assert.equal(status, 404);
  });

  it("400s when given neither a graph nor an id", async () => {
    assert.equal((await api("POST", "/api/generate", { name: "x" })).status, 400);
  });
});

describe("tool files", () => {
  const withTool = (files: string[]) => {
    const g: any = minimalGraph();
    g.nodes.push({ id: "tool_3", kind: "tool", name: "tool", x: 0, y: 200,
                   props: { files } });
    g.edges.push({ src: "tool_3", dst: "a1", props: {} });
    return g;
  };

  it("offers MetaAgent's library so a name can be chosen, not guessed", async () => {
    const { status, json } = await api("GET", "/api/tools");
    assert.equal(status, 200);
    assert.ok(json.tools.length > 10, "expected MetaAgent's tools/ to have files in it");
    assert.ok(json.tools.every((t: any) => t.name.endsWith(".py")));
    assert.ok(!json.tools.some((t: any) => t.name.startsWith("_")),
              "underscore-private modules are helpers, not selectable tool files");
  });

  it("stages the chosen file so the agent actually gets the tool", async () => {
    // The gap this closes: a browser-built graph naming a tool file used to die deep in
    // codegen with a bare FileNotFoundError, because the file never reached the job.
    const queued = await api("POST", "/api/generate",
                             { graph: withTool(["add_numbers.py"]), name: "ToolDemo" });
    const job = await settle(queued.json.jobId);
    assert.equal(job.state, "done", job.error);
    assert.equal(job.result.ok, true, JSON.stringify(job.result.errors));
    assert.deepEqual(job.result.toolsStaged, ["add_numbers.py"]);

    const agent = path.join(CONFIG.dataDir, "jobs", queued.json.jobId,
                            "out", "ToolDemo", "agent.py");
    assert.match(fs.readFileSync(agent, "utf-8"), /def add_numbers/,
                 "the tool was not inlined into the generated agent");
  });

  it("validation and generation agree about a tool file", async () => {
    // They disagreed once: analyze said "not found" for a graph that generated fine.
    // A validator you cannot trust is worse than none.
    const graph = withTool(["add_numbers.py"]);
    const { json } = await api("POST", "/api/analyze", { graph });
    assert.equal(json.ok, true, JSON.stringify(json.errors));

    const queued = await api("POST", "/api/generate", { graph, name: "Agree" });
    assert.equal((await settle(queued.json.jobId)).result.ok, true);
  });

  it("names a missing file instead of raising FileNotFoundError", async () => {
    const { json } = await api("POST", "/api/analyze", { graph: withTool(["nope.py"]) });
    assert.equal(json.ok, false);
    assert.match(json.errors[0], /tool file\(s\) not found: nope\.py/);
    assert.doesNotMatch(json.errors[0], /FileNotFoundError|Traceback/);
  });

  it("cannot be talked into reading outside the tool library", async () => {
    // basename() reduces this to a name that is simply not in the library.
    const { json } = await api("POST", "/api/analyze",
                               { graph: withTool(["../../config.json"]) });
    assert.equal(json.ok, false);
    // A plain containment check rather than a regex: the point is that no path
    // fragment from the request comes back, and escaping a character class for
    // that is how the assertion itself ends up broken.
    const echoed = JSON.stringify(json);
    assert.ok(!echoed.includes("../") && !echoed.includes("..\\"),
              "a traversal path was echoed back to the client");
  });
});

describe("reading the generated source", () => {
  it("serves a file out of a finished build", async () => {
    const queued = await api("POST", "/api/generate",
                             { graph: minimalGraph(), name: "Viewer" });
    const job = await settle(queued.json.jobId);
    assert.equal(job.result.ok, true);

    const { status, json } = await api(
      "GET", `/api/jobs/${queued.json.jobId}/file?path=agent.py`);
    assert.equal(status, 200);
    assert.equal(json.path, "agent.py");
    assert.ok(json.bytes > 1000);
    assert.match(json.text, /def |import /, "that does not look like the agent");
  });

  it("refuses a path that climbs out of the build", async () => {
    // The path comes from a query string. "It is one of the files we listed" is a
    // weaker promise than "it resolves inside this build", so containment is checked.
    const queued = await api("POST", "/api/generate",
                             { graph: minimalGraph(), name: "Escape" });
    await settle(queued.json.jobId);
    for (const bad of ["../../graph.json", "../request.json",
                       "..%2f..%2fconfig.json"]) {
      const { status } = await api(
        "GET", `/api/jobs/${queued.json.jobId}/file?path=${encodeURIComponent(bad)}`);
      assert.equal(status, 404, bad);
    }
  });

  it("400s without a path, 404s for an unknown build", async () => {
    const queued = await api("POST", "/api/generate",
                             { graph: minimalGraph(), name: "Args" });
    await settle(queued.json.jobId);
    assert.equal((await api("GET", `/api/jobs/${queued.json.jobId}/file`)).status, 400);
    assert.equal(
      (await api("GET", `/api/jobs/${crypto.randomUUID()}/file?path=agent.py`)).status,
      404);
  });
});

describe("shared state reaches the generator", () => {
  it("carries state_schema through analyze and generate", async () => {
    // The web designer could not edit state_schema at all, which made graph mode
    // unbuildable in the browser: an If/Else node had nothing to branch on.
    const graph: any = minimalGraph();
    graph.state_schema = [
      { name: "score", type: "float", reducer: "max", default: 0,
        description: "how good the draft is" },
    ];
    graph.nodes.push({ id: "c1", kind: "condition", name: "gate", x: 400, y: 0,
                       props: { branches: [{ expr: "score >= 0.8", to: "solo" },
                                           { expr: "", to: "solo" }] } });
    graph.edges.push({ src: "a1", dst: "c1", props: {} });

    const { json } = await api("POST", "/api/analyze", { graph });
    // The point is that the field is UNDERSTOOD — a graph-mode runner, not a chain.
    assert.equal(json.mode, "graph", JSON.stringify(json.errors));
  });
});

describe("link properties", () => {
  it("carries an LLM fallback priority through generation", async () => {
    // `priority` lives on the LINK, so the same model can be primary for one agent and
    // a fallback for another. It appears 41 times across the shipped graphs.
    const graph: any = minimalGraph();
    graph.nodes.push({ id: "l2", kind: "llm", name: "backup", x: 200, y: 120,
                       props: { provider: "siliconflow", model: "backup-model",
                                api_key: "", base_url: "http://localhost" } });
    graph.edges[0].props = { priority: 1 };
    graph.edges.push({ src: "l2", dst: "a1", props: { priority: 2 } });

    const queued = await api("POST", "/api/generate", { graph, name: "Failover" });
    const job = await settle(queued.json.jobId);
    assert.equal(job.result.ok, true, JSON.stringify(job.result.errors));

    const cfg = await api("GET", `/api/jobs/${queued.json.jobId}/file?path=config.json`);
    const llms = JSON.parse(cfg.json.text).llms.solo;
    assert.equal(llms.length, 2, "both models should reach config.json");
    assert.equal(llms[0].model, "deepseek-ai/DeepSeek-V4-Flash", "priority 1 is primary");
    assert.equal(llms[1].model, "backup-model", "priority 2 is the fallback");
  });

  it("an UNSET priority sorts after every numbered one", async () => {
    // The trap that broke the editor: codegen sorts with
    // `(priority or 0) or Infinity`, so absent means LAST, not 1. The first version of
    // the panel deleted a priority of 1 as "the default" and quietly demoted the link
    // the user had just made primary.
    const graph: any = minimalGraph();
    graph.nodes.push({ id: "l2", kind: "llm", name: "numbered", x: 200, y: 120,
                       props: { provider: "siliconflow", model: "numbered-model",
                                api_key: "", base_url: "http://localhost" } });
    // l1 is left UNSET; l2 is numbered.
    graph.edges.push({ src: "l2", dst: "a1", props: { priority: 2 } });

    const queued = await api("POST", "/api/generate", { graph, name: "Unset" });
    await settle(queued.json.jobId);
    const cfg = await api("GET", `/api/jobs/${queued.json.jobId}/file?path=config.json`);
    const llms = JSON.parse(cfg.json.text).llms.solo;
    assert.equal(llms[0].model, "numbered-model",
                 "a numbered link should beat an unset one");
  });
});

describe("graph-level settings reach the generator", () => {
  it("carries a storage backend into the generated config", async () => {
    const graph: any = minimalGraph();
    graph.storage = { backend: "sqlite", sqlite_path: "sessions.db", checkpoint: true };

    const queued = await api("POST", "/api/generate", { graph, name: "Stored" });
    const job = await settle(queued.json.jobId);
    assert.equal(job.result.ok, true, JSON.stringify(job.result.errors));

    const cfg = await api("GET", `/api/jobs/${queued.json.jobId}/file?path=config.json`);
    const parsed = JSON.parse(cfg.json.text);
    assert.equal(parsed.storage.backend, "sqlite");
    assert.equal(parsed.storage.sqlite_path, "sessions.db");
    assert.equal(parsed.checkpoint, true, "checkpointing did not reach the agent");
  });

  it("leaves the default storage out of the graph entirely", async () => {
    // Rule 8: an option nobody touched must not appear. The editor deletes a key when
    // it is set back to its default, so a graph that never opened this dialog
    // serialises exactly as it did before the dialog existed.
    const graph: any = minimalGraph();
    graph.storage = {};
    const { json } = await api("POST", "/api/analyze", { graph });
    assert.equal(json.ok, true, JSON.stringify(json.errors));
  });

  it("carries a custom state type through to the agent", async () => {
    // A type_def turns a state field from a scalar into a RECORD, and its schema is what
    // drives the agent's set_state tool.
    const graph: any = minimalGraph();
    graph.type_defs = {
      Finding: {
        description: "One issue the analyst found.",
        merge: "merge_deep",
        schema: { type: "object",
                  properties: { title: { type: "string" }, score: { type: "number" } } },
      },
    };
    graph.state_schema = [
      { name: "findings", type: "list[Finding]", reducer: "extend", default: [],
        description: "everything found so far" },
    ];
    graph.nodes[0].props = { role: "single", writes: ["findings"] };

    const queued = await api("POST", "/api/generate", { graph, name: "Typed" });
    const job = await settle(queued.json.jobId);
    assert.equal(job.result.ok, true, JSON.stringify(job.result.errors));

    const agent = await api("GET", `/api/jobs/${queued.json.jobId}/file?path=agent.py`);
    assert.match(agent.json.text, /Finding/,
                 "the custom type never reached the generated agent");
    assert.match(agent.json.text, /findings/);
  });

  it("accepts an empty type_defs in either shape", async () => {
    // Saved graphs carry [] here; fresh ones carry {}. Both must work, which is why the
    // browser normalises rather than guessing.
    for (const empty of [[], {}]) {
      const graph: any = minimalGraph();
      graph.type_defs = empty;
      const { json } = await api("POST", "/api/analyze", { graph });
      assert.equal(json.ok, true, `type_defs=${JSON.stringify(empty)}`);
    }
  });
});

describe("design review", () => {
  it("reports findings without generating anything", async () => {
    const { status, json } = await api("POST", "/api/estimate",
                                       { graph: minimalGraph() });
    assert.equal(status, 200);
    assert.equal(json.ok, true, JSON.stringify(json.errors));
    assert.ok(Array.isArray(json.findings), "no findings array came back");
    assert.equal(json.files, undefined, "review must not generate");
    for (const f of json.findings) {
      assert.ok(f.severity && f.message, "a finding is missing its fields");
    }
  });

  it("is deterministic — no key, no model call, no cost", async () => {
    // Asserted by TIMING: an LLM-judged review could not return in well under a second,
    // and the whole point of wiring `use_llm=false` is that a keystroke cannot spend
    // money.
    const started = Date.now();
    await api("POST", "/api/estimate", { graph: minimalGraph() });
    assert.ok(Date.now() - started < 8000, "that looks like it called a model");
  });

  it("400s without a graph", async () => {
    assert.equal((await api("POST", "/api/estimate", {})).status, 400);
  });
});

describe("parsing a .mta without storing it", () => {
  const SCOUT = path.join(CONFIG.metaagent, "graphs", "xCodeScoutAgent.mta");

  it("returns the graph and adds nothing to the saved list", async (t) => {
    if (!fs.existsSync(SCOUT)) return t.skip("no sample .mta");
    const before = (await api("GET", "/api/graphs")).json.graphs.length;

    const { status, json } = await api("POST", "/api/mta/parse", undefined,
                                       fs.readFileSync(SCOUT));
    assert.equal(status, 200);
    assert.ok(json.graph.nodes.length >= 7);

    const after = (await api("GET", "/api/graphs")).json.graphs.length;
    assert.equal(after, before, "parsing for a merge must not save a second graph");
  });

  it("rejects something that is not a bundle", async () => {
    const { status } = await api("POST", "/api/mta/parse", undefined,
                                 Buffer.from("not a zip"));
    assert.equal(status, 400);
  });
});

describe("run history", () => {
  it("reports an empty list for a build that has never been run", async () => {
    const queued = await api("POST", "/api/generate",
                             { graph: minimalGraph(), name: "NoRuns" });
    await settle(queued.json.jobId);
    const { status, json } = await api("GET", `/api/jobs/${queued.json.jobId}/traces`);
    assert.equal(status, 200);
    assert.deepEqual(json.traces, [], "a fresh build has no traces");
  });

  it("lists a trace once one exists, newest first", async () => {
    const queued = await api("POST", "/api/generate",
                             { graph: minimalGraph(), name: "Traced" });
    const job = await settle(queued.json.jobId);
    // Write traces the way a run would, rather than running an agent: this is a test of
    // the LISTING, and a real run needs a model.
    const dir = path.join(CONFIG.dataDir, "jobs", queued.json.jobId,
                          "out", job.result.name, "traces");
    fs.mkdirSync(dir, { recursive: true });
    // Built with JSON.stringify rather than a literal: a hand-escaped JSON string
    // inside a JS string is exactly where a stray backslash hides.
    const line = JSON.stringify({ t: 0, kind: "run_start" }) + String.fromCharCode(10);
    fs.writeFileSync(path.join(dir, "run-older.jsonl"), line);
    fs.writeFileSync(path.join(dir, "run-newer.jsonl"), line);
    fs.utimesSync(path.join(dir, "run-older.jsonl"), new Date(1), new Date(1));

    const { json } = await api("GET", `/api/jobs/${queued.json.jobId}/traces`);
    assert.equal(json.traces.length, 2);
    assert.equal(json.traces[0].name, "run-newer.jsonl", "newest should come first");

    // and the file endpoint can read one back
    const file = await api(
      "GET", `/api/jobs/${queued.json.jobId}/file?path=traces%2Frun-newer.jsonl`);
    assert.equal(file.status, 200);
    assert.match(file.json.text, /run_start/);
  });

  it("404s traces for an unknown build", async () => {
    assert.equal((await api("GET", `/api/jobs/${crypto.randomUUID()}/traces`)).status, 404);
  });
});

describe("rule 10 at the edge", () => {
  it("refuses a graph carrying a literal API key", async () => {
    const queued = await api("POST", "/api/generate",
                             { graph: minimalGraph("sk-live-leaked-value"), name: "Leaky" });
    assert.equal(queued.status, 202, "the refusal is a job RESULT, not a rejected request");

    const job = await settle(queued.json.jobId);
    assert.equal(job.state, "done", "a refusal is a considered answer, not a crash");
    assert.equal(job.result.ok, false);
    assert.match(job.result.errors[0], /credential/);
    assert.equal(job.result.hasDownload, false);
  });

  it("scrubs on request, and the key never reaches the artifact", async () => {
    const queued = await api("POST", "/api/generate", {
      graph: minimalGraph("sk-live-leaked-value"), name: "Scrubbed", scrub: true });
    const job = await settle(queued.json.jobId);
    assert.equal(job.result.ok, true, JSON.stringify(job.result.errors));
    assert.equal(job.result.scrubbed, 1);

    const dir = path.join(CONFIG.dataDir, "jobs", queued.json.jobId, "out");
    let found = false;
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (fs.readFileSync(full, "utf-8").includes("sk-live-leaked-value")) found = true;
      }
    };
    walk(dir);
    assert.equal(found, false, "the scrubbed key reached the generated code");
  });
});

describe("jobs", () => {
  it("lists only this principal's jobs", async () => {
    const { json } = await api("GET", "/api/jobs");
    assert.ok(Array.isArray(json.jobs));
    assert.ok(json.jobs.every((j: any) => j.ownerId === "local"));
  });

  it("404s an unknown or malformed job id", async () => {
    assert.equal((await api("GET", `/api/jobs/${crypto.randomUUID()}`)).status, 404);
    assert.equal((await api("GET", "/api/jobs/not-an-id")).status, 404);
  });

  it("409s a download for a job that is not done", async () => {
    const queued = await api("POST", "/api/generate",
                             { graph: minimalGraph(), name: "Racing" });
    const early = await api("GET", `/api/jobs/${queued.json.jobId}/download`);
    assert.ok([409, 200].includes(early.status));
    if (early.status === 409) assert.match(early.json.error, /queued|running/);
    await settle(queued.json.jobId);
  });
});

describe("hardening", () => {
  it("answers 413 on an oversized body rather than buffering it", async () => {
    // The server stops READING at the limit but still replies: a dropped connection
    // would leave the client unable to tell a size limit from a crash.
    const huge = Buffer.alloc(CONFIG.maxUploadBytes + 1024, 0x41);
    const { status, json } = await api("POST", "/api/mta", undefined, huge);
    assert.equal(status, 413);
    assert.match(json.error, /larger than/);
  });

  it("does not serve files outside public/", async () => {
    for (const attempt of ["/../package.json", "/..%2fpackage.json",
                           "/../../MetaAgent/config.json"]) {
      const { status } = await api("GET", attempt);
      assert.equal(status, 404, attempt);
    }
  });

  it("404s an unknown route", async () => {
    assert.equal((await api("GET", "/api/nope")).status, 404);
  });
});
