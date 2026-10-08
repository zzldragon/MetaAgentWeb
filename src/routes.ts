// The API. Every handler takes a Principal and every lookup goes through it, so the
// multi-tenant version is a change to `principalOf`, not to this file.
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";

import { CONFIG } from "./config.ts";
import { readBody, readJsonBody, sendDownload, sendError, sendJson } from "./http.ts";
import type { Res } from "./http.ts";
import { isId } from "./ids.ts";
import * as gen from "./mtagen.ts";
import { ensureFor, pathFor, within } from "./paths.ts";
import { principalOf } from "./principal.ts";
import type { Principal } from "./principal.ts";
import { JobQueue } from "./queue.ts";
import type { Job } from "./queue.ts";
import * as store from "./store.ts";
import * as runner from "./run.ts";
import * as toolLib from "./tools.ts";

export type GenJob = gen.GenResult & { graphId?: string; toolsStaged?: string[] };

/** Everything a request handler needs, assembled once by the server. */
export type Deps = { queue: JobQueue<GenJob>; schemaCache: { text?: string } };

type Handler = (req: IncomingMessage, res: Res, principal: Principal,
                params: string[], deps: Deps) => Promise<void> | void;

type Route = { method: string; pattern: RegExp; handler: Handler };

const routes: Route[] = [];
const on = (method: string, pattern: RegExp, handler: Handler): void => {
  routes.push({ method, pattern, handler });
};

// ── schema ──────────────────────────────────────────────────────────────────
on("GET", /^\/api\/schema$/, async (_req, res, _p, _m, deps) => {
  // Cached in memory: the registries cannot change while the server runs, and a Python
  // spawn per canvas load would be silly. `?fresh=1` is for someone editing MetaAgent.
  if (!deps.schemaCache.text) {
    deps.schemaCache.text = await gen.schema();
  }
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(deps.schemaCache.text);
});

// ── the tool library ─────────────────────────────────────────
on("GET", /^\/api\/tools$/, (_req, res) => {
  // The .py files a Tool node can reference. Read from disk each time rather than
  // cached: unlike the node registry, someone can drop a new tool file in while the
  // server is running, and needing a restart to see it would be a silly surprise.
  sendJson(res, 200, { tools: toolLib.list() });
});

// ── graphs ──────────────────────────────────────────────────────────────────
on("GET", /^\/api\/graphs$/, (_req, res, principal) => {
  sendJson(res, 200, { graphs: store.list(principal) });
});

on("POST", /^\/api\/graphs$/, async (req, res, principal) => {
  const body = await readJsonBody<{ name?: string; graph?: unknown }>(
    req, CONFIG.maxUploadBytes);
  if (!body.graph || typeof body.graph !== "object") {
    return sendError(res, 400, "body needs a `graph` object");
  }
  sendJson(res, 201, store.create(principal, body.name ?? "Untitled", body.graph));
});

on("GET", /^\/api\/graphs\/([^/]+)$/, (_req, res, principal, [id]) => {
  const meta = store.meta(principal, id!);
  const graph = meta && store.read(principal, id!);
  if (!meta || !graph) return sendError(res, 404, "no such graph");
  sendJson(res, 200, { ...meta, graph });
});

on("PUT", /^\/api\/graphs\/([^/]+)$/, async (req, res, principal, [id]) => {
  const body = await readJsonBody<{ name?: string; graph?: unknown }>(
    req, CONFIG.maxUploadBytes);
  if (!body.graph) return sendError(res, 400, "body needs a `graph` object");
  const meta = store.update(principal, id!, body.graph, body.name);
  if (!meta) return sendError(res, 404, "no such graph");
  sendJson(res, 200, meta);
});

on("DELETE", /^\/api\/graphs\/([^/]+)$/, (_req, res, principal, [id]) => {
  if (!store.remove(principal, id!)) return sendError(res, 404, "no such graph");
  sendJson(res, 200, { deleted: id });
});

// ── upload / export a .mta ──────────────────────────────────────────────────
on("POST", /^\/api\/mta$/, async (req, res, principal, _m, _deps) => {
  // The raw bytes ARE the body — no multipart. A .mta is one file, and a hand-rolled
  // multipart parser is a liability for no gain; the browser sends the File directly.
  const raw = await readBody(req, CONFIG.maxUploadBytes);
  if (raw.length === 0) return sendError(res, 400, "empty upload");
  const name = new URL(req.url ?? "/", "http://localhost").searchParams.get("name")
    ?? "Uploaded";

  // Park it, then let Python read the graph back out. mta_gen is the only thing that
  // understands a .mta, and having one reader means the server never grows a second,
  // subtly different unzip.
  const scratchId = crypto.randomUUID();
  const scratch = ensureFor(principal, "uploads", scratchId);
  const mtaFile = path.join(scratch, "upload.mta");
  fs.writeFileSync(mtaFile, raw);
  try {
    const report = await gen.generate({
      mtaPath: mtaFile, outDir: path.join(scratch, "out"), analyzeOnly: true,
    });
    if (!report.ok) {
      return sendJson(res, 400, { error: "the bundle did not validate", report });
    }
    // analyze-only validates but writes nothing back, so the graph comes from the
    // bundle itself.
    const graph = await readGraphFromMta(mtaFile);
    if (!graph) return sendError(res, 400, "could not read graph.json from the bundle");
    const meta = store.create(principal, name, graph, raw);
    sendJson(res, 201, { ...meta, report });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

on("GET", /^\/api\/graphs\/([^/]+)\/mta$/, (_req, res, principal, [id]) => {
  const file = store.sourceOf(principal, id!);
  if (!file) return sendError(res, 404, "this graph has no uploaded bundle");
  const meta = store.meta(principal, id!);
  sendDownload(res, file, `${meta?.name ?? "graph"}.mta`, "application/zip");
});

// ── analyze ─────────────────────────────────────────────────────────────────
on("POST", /^\/api\/analyze$/, async (req, res, principal) => {
  const body = await readJsonBody<{ graph?: unknown }>(req, CONFIG.maxUploadBytes);
  if (!body.graph) return sendError(res, 400, "body needs a `graph` object");
  // Synchronous, not queued: the canvas calls this on every edit and needs an answer,
  // and analyze does no generation. The scratch dir is gone before the response is.
  const scratchId = crypto.randomUUID();
  const scratch = ensureFor(principal, "uploads", scratchId);
  try {
    const graphFile = path.join(scratch, "graph.json");
    fs.writeFileSync(graphFile, JSON.stringify(body.graph), "utf-8");
    // Stage the tool files here TOO, exactly as a real build does. Without this the
    // canvas showed "tool file(s) not found" for a graph that generates perfectly --
    // validation and generation disagreeing is worse than either being wrong, because
    // the one you see is the one you do not trust.
    const toolsDir = path.join(scratch, "tools");
    toolLib.stage(body.graph, toolsDir);
    sendJson(res, 200, await gen.analyze(graphFile, path.join(scratch, "out"), toolsDir));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ── design review ─────────────────────────────────────────
on("POST", /^\/api\/estimate$/, async (req, res, principal) => {
  // Not the same question as /api/analyze. Analyze asks "can this generate?"; estimate
  // asks "is this a sensible design?" -- unbounded budgets, an orchestrator with no
  // caps, a fan-out writing an overwrite field. Deterministic only, so it costs nothing
  // and needs no key.
  const body = await readJsonBody<{ graph?: unknown }>(req, CONFIG.maxUploadBytes);
  if (!body.graph) return sendError(res, 400, "body needs a `graph` object");
  const scratch = ensureFor(principal, "uploads", crypto.randomUUID());
  try {
    const graphFile = path.join(scratch, "graph.json");
    fs.writeFileSync(graphFile, JSON.stringify(body.graph), "utf-8");
    toolLib.stage(body.graph, path.join(scratch, "tools"));
    sendJson(res, 200, await gen.generate({
      graphPath: graphFile, outDir: path.join(scratch, "out"),
      toolsDir: path.join(scratch, "tools"), estimate: true,
    }));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ── parse a .mta WITHOUT storing it (for Merge) ─────────────────────
on("POST", /^\/api\/mta\/parse$/, async (req, res, principal) => {
  // Merge needs the graph out of a bundle without adding a second saved graph to the
  // list. Same reader as the upload path -- one implementation of "what is in a .mta".
  const raw = await readBody(req, CONFIG.maxUploadBytes);
  if (raw.length === 0) return sendError(res, 400, "empty upload");
  const scratch = ensureFor(principal, "uploads", crypto.randomUUID());
  const mtaFile = path.join(scratch, "upload.mta");
  try {
    fs.writeFileSync(mtaFile, raw);
    const graph = await readGraphFromMta(mtaFile);
    if (!graph) return sendError(res, 400, "could not read graph.json from the bundle");
    sendJson(res, 200, { graph });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// ── run history ───────────────────────────────────────────
on("GET", /^\/api\/jobs\/([^/]+)\/traces$/, (_req, res, principal, [id], deps) => {
  // A generated agent writes a JSONL trace per run, beside itself. After a Run, that is
  // the record of what actually happened -- which tools fired, how long each took.
  const job = ownedJob(deps, principal, id!);
  if (!job || !job.result?.name) return sendError(res, 404, "no such build");
  const dir = path.join(pathFor(principal, "jobs", job.id), "out", job.result.name,
                        "traces");
  if (!fs.existsSync(dir)) return sendJson(res, 200, { traces: [] });
  const traces = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      return { name: f, bytes: stat.size, at: stat.mtimeMs };
    })
    .sort((a, b) => b.at - a.at);
  sendJson(res, 200, { traces });
});

// ── generate ────────────────────────────────────────────────────────────────
on("POST", /^\/api\/generate$/, async (req, res, principal, _m, deps) => {
  const body = await readJsonBody<{
    graphId?: string; graph?: unknown; name?: string;
    target?: "python" | "ts"; codeStyle?: "single" | "package"; scrub?: boolean;
  }>(req, CONFIG.maxUploadBytes);

  let graph: unknown = body.graph;
  if (body.graphId) {
    if (!isId(body.graphId)) return sendError(res, 400, "bad graphId");
    graph = store.read(principal, body.graphId);
    if (!graph) return sendError(res, 404, "no such graph");
  }
  if (!graph) return sendError(res, 400, "give either `graphId` or `graph`");

  const submitted = deps.queue.submit(principal, "generate");
  if (!submitted.ok) return sendError(res, 429, submitted.reason);

  const job = submitted.job;
  // The job's whole world is its own directory, created before it is queued so a
  // download can 404 rather than crash if the job is collected early.
  const jobDir = ensureFor(principal, "jobs", job.id);
  fs.writeFileSync(path.join(jobDir, "graph.json"), JSON.stringify(graph), "utf-8");
  fs.writeFileSync(path.join(jobDir, "request.json"), JSON.stringify({
    name: body.name ?? "Agent", target: body.target ?? "python",
    codeStyle: body.codeStyle ?? "single", scrub: body.scrub === true,
    graphId: body.graphId,
  }), "utf-8");

  sendJson(res, 202, { jobId: job.id, state: job.state });
});

on("GET", /^\/api\/jobs$/, (_req, res, principal, _m, deps) => {
  sendJson(res, 200, { jobs: deps.queue.list(principal.id).map(publicJob) });
});

on("GET", /^\/api\/jobs\/([^/]+)$/, (_req, res, principal, [id], deps) => {
  const job = ownedJob(deps, principal, id!);
  if (!job) return sendError(res, 404, "no such job");
  sendJson(res, 200, publicJob(job));
});

on("DELETE", /^\/api\/jobs\/([^/]+)$/, (_req, res, principal, [id], deps) => {
  const job = ownedJob(deps, principal, id!);
  if (!job) return sendError(res, 404, "no such job");
  sendJson(res, 200, { cancelled: deps.queue.cancel(job.id) });
});

on("GET", /^\/api\/jobs\/([^/]+)\/download$/, (_req, res, principal, [id], deps) => {
  const job = ownedJob(deps, principal, id!);
  if (!job) return sendError(res, 404, "no such job");
  if (job.state !== "done") return sendError(res, 409, `job is ${job.state}`);
  const zip = job.result?.zip;
  if (!zip || !fs.existsSync(zip)) return sendError(res, 404, "no artifact");
  // Re-check containment: the path came from a subprocess, and "we produced it" is a
  // weaker guarantee than "it is inside this job's directory".
  const jobDir = pathFor(principal, "jobs", job.id);
  if (!within(jobDir, path.relative(jobDir, zip))) {
    return sendError(res, 500, "artifact escaped its job directory");
  }
  sendDownload(res, zip, `${job.result?.name ?? "agent"}.zip`, "application/zip");
});

on("GET", /^\/api\/jobs\/([^/]+)\/file$/, (req, res, principal, [id], deps) => {
  // Read one file out of a finished build -- the browser's "Check Code", the same view
  // the desktop offers on right-click. Serving it from the job rather than the zip means
  // no download and no unpacking to read what your graph produced.
  const job = ownedJob(deps, principal, id!);
  if (!job || job.state !== "done" || !job.result?.ok) {
    return sendError(res, 404, "no such build");
  }
  const wanted = new URL(req.url ?? "/", "http://localhost").searchParams.get("path");
  if (!wanted) return sendError(res, 400, "give ?path=agent.py");

  const root = path.join(pathFor(principal, "jobs", job.id), "out", job.result.name ?? "");
  const full = within(root, wanted);
  // `within` is the guard: the path comes from a query string, and "it is one of the
  // files we listed" is a weaker promise than "it resolves inside this build".
  if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return sendError(res, 404, "no such file in that build");
  }
  const bytes = fs.statSync(full).size;
  const CAP = 2_000_000;
  if (bytes > CAP) {
    return sendJson(res, 200, {
      path: wanted, bytes, truncated: true,
      text: fs.readFileSync(full, "utf-8").slice(0, CAP),
    });
  }
  sendJson(res, 200, { path: wanted, bytes, text: fs.readFileSync(full, "utf-8") });
});

// ── running a generated agent (fenced: see run.ts) ────────────────────
on("GET", /^\/api\/run-status$/, (_req, res) => {
  // The front end asks BEFORE offering a Run button, so a disabled server explains
  // itself in the UI instead of failing when someone presses it.
  const verdict = runner.allowed();
  sendJson(res, 200, verdict.ok
    ? { enabled: true, hasKey: Boolean(CONFIG.runApiKey) }
    : { enabled: false, reason: verdict.reason });
});

on("POST", /^\/api\/jobs\/([^/]+)\/run$/, async (req, res, principal, [id], deps) => {
  const verdict = runner.allowed();
  if (!verdict.ok) return sendError(res, 403, verdict.reason);

  const job = ownedJob(deps, principal, id!);
  if (!job) return sendError(res, 404, "no such job");
  if (job.state !== "done" || !job.result?.ok) {
    return sendError(res, 409, "that job did not produce an agent");
  }
  const body = await readJsonBody<{ task?: string }>(req, CONFIG.maxUploadBytes);
  const task = (body.task ?? "").trim();
  if (!task) return sendError(res, 400, "give a `task` for the agent to do");

  const dir = runner.agentDir(pathFor(principal, "jobs", job.id), job.result.name ?? "");
  if (!dir) return sendError(res, 404, "the generated agent is no longer on disk");

  sendJson(res, 202, runner.start(principal, job.id, dir, task));
});

on("GET", /^\/api\/runs\/([^/]+)$/, (_req, res, principal, [id]) => {
  if (!isId(id!) || !runner.ownedBy(id!, principal)) {
    return sendError(res, 404, "no such run");
  }
  sendJson(res, 200, runner.get(id!));
});

on("DELETE", /^\/api\/runs\/([^/]+)$/, (_req, res, principal, [id]) => {
  if (!isId(id!) || !runner.ownedBy(id!, principal)) {
    return sendError(res, 404, "no such run");
  }
  sendJson(res, 200, { stopped: runner.stop(id!) });
});

on("GET", /^\/api\/runs\/([^/]+)\/stream$/, (req, res, principal, [id]) => {
  if (!isId(id!) || !runner.ownedBy(id!, principal)) {
    return sendError(res, 404, "no such run");
  }
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    // Chunked output must not sit in a proxy buffer waiting to be worth forwarding.
    "x-accel-buffering": "no",
  });

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}
data: ${JSON.stringify(data)}

`);
  };
  // Replay first, so a subscriber that connects a moment late still sees the run from
  // its beginning rather than joining halfway through.
  const already = runner.backlog(id!);
  if (already) send("output", already);

  const current = runner.get(id!);
  if (current && current.state !== "running" && current.state !== "starting") {
    send("done", current);
    res.end();
    return;
  }

  const unsubscribe = runner.subscribe(
    id!,
    (chunk) => send("output", chunk),
    (run) => { send("done", run); res.end(); });
  req.on("close", unsubscribe);
});

// ── helpers ─────────────────────────────────────────────────────────────────
function ownedJob(deps: Deps, principal: Principal, id: string): Job<GenJob> | undefined {
  if (!isId(id)) return undefined;
  const job = deps.queue.get(id);
  // Ownership, not just existence — the same rule the graph store applies.
  return job && job.ownerId === principal.id ? job : undefined;
}

/** A job as the client sees it: no filesystem paths leak out. */
function publicJob(job: Job<GenJob>) {
  const { result, ...rest } = job;
  return {
    ...rest,
    result: result && {
      ok: result.ok, errors: result.errors, warnings: result.warnings,
      mode: result.mode, entry: result.entry, name: result.name,
      files: result.files, bytes: result.bytes, zipBytes: result.zip_bytes,
      zipSkipped: result.zip_skipped, propsDefaulted: result.props_defaulted,
      scrubbed: result.scrubbed, toolsRestored: result.tools_restored,
      toolsStaged: result.toolsStaged,
      hasDownload: Boolean(result.zip),
    },
  };
}

/**
 * Pull `graph.json` out of a .mta (which is a zip).
 *
 * Delegated to Python rather than unzipped here: MetaAgent already has one reader for
 * this format, and a second implementation in another language is a place for the two
 * to disagree about what a bundle contains.
 *
 * The bytes come back through `stdout.buffer` UNDECODED, and are parsed as UTF-8 on
 * this side. Writing text instead made Python re-encode it for the console, which on a
 * GBK Windows box threw on the first emoji in a graph -- a failure that looked like
 * "the bundle has no graph.json" and had nothing to do with the bundle.
 */
async function readGraphFromMta(file: string): Promise<unknown | null> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const code = "import sys,zipfile;"
    + "sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read('graph.json'))";
  try {
    const { stdout } = await run(CONFIG.python, ["-c", code, file], {
      maxBuffer: CONFIG.maxUploadBytes,
      encoding: "buffer",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    return JSON.parse(Buffer.from(stdout).toString("utf-8")) as unknown;
  } catch (err) {
    // Logged, not swallowed silently: the first version returned null on any failure,
    // so an encoding error 38 KB into the file presented as a missing graph.json.
    console.error("[mta] could not read graph.json:",
                  err instanceof Error ? err.message : err);
    return null;
  }
}


/** Find and run the handler for a request. Returns false when nothing matched. */
export async function route(req: IncomingMessage, res: Res, deps: Deps): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  for (const entry of routes) {
    if (entry.method !== (req.method ?? "GET")) continue;
    const match = entry.pattern.exec(url.pathname);
    if (!match) continue;
    await entry.handler(req, res, principalOf(req), match.slice(1), deps);
    return true;
  }
  return false;
}
