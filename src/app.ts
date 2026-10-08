// The application: routing, the job runner, and the sweeper — assembled but NOT
// listening.
//
// Split from `server.ts` so a test can build the whole app, drive it over a real socket
// on an ephemeral port, and shut it down cleanly. A module that starts listening as a
// side effect of being imported cannot be tested without leaking a server.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { CONFIG } from "./config.ts";
import { sendError, sendStatic } from "./http.ts";
import * as gen from "./mtagen.ts";
import { pathFor } from "./paths.ts";
import { LOCAL } from "./principal.ts";
import { concurrencyPolicy, JobQueue } from "./queue.ts";
import type { Job } from "./queue.ts";
import { route } from "./routes.ts";
import * as toolLib from "./tools.ts";
import type { Deps, GenJob } from "./routes.ts";

export type App = {
  server: http.Server;
  queue: JobQueue<GenJob>;
  deps: Deps;
  /** Stop the sweeper and close the socket. */
  close(): Promise<void>;
};

/**
 * Run one generation job.
 *
 * Reads its inputs from the job directory rather than closing over the HTTP request: a
 * job that starts minutes after it was submitted should not depend on anything still
 * being in memory.
 */
async function runJob(job: Job<GenJob>, signal: AbortSignal): Promise<GenJob> {
  const dir = pathFor(LOCAL, "jobs", job.id);
  const request = JSON.parse(
    fs.readFileSync(path.join(dir, "request.json"), "utf-8")) as {
      name: string; target: "python" | "ts"; codeStyle: "single" | "package";
      scrub: boolean; graphId?: string;
    };

  // Copy the tool files this graph references out of MetaAgent's library and into the
  // job's own directory. Codegen reads them off disk, and without this a browser-built
  // graph that names a tool file fails on a file that was never delivered.
  const toolsDir = path.join(dir, "tools");
  const staged = toolLib.stage(
    JSON.parse(fs.readFileSync(path.join(dir, "graph.json"), "utf-8")), toolsDir);

  const result = await gen.generate({
    graphPath: path.join(dir, "graph.json"),
    outDir: path.join(dir, "out"),
    toolsDir,
    name: request.name,
    target: request.target,
    codeStyle: request.codeStyle,
    scrub: request.scrub,
    zip: true,
    signal,
  });
  // A refusal — a credential in the graph, a validation error — is a RESULT, not a
  // failure: the caller asked a fair question and got a considered answer. Throwing
  // here would turn "your graph has a key in it" into "the server broke".
  return { ...result, graphId: request.graphId, toolsStaged: staged.copied };
}

export function createApp(options: { quiet?: boolean } = {}): App {
  const log = options.quiet ? () => {} : console.log;
  const queue = new JobQueue<GenJob>(
    runJob, CONFIG.maxConcurrentJobs, concurrencyPolicy(CONFIG.maxConcurrentJobs));
  const deps: Deps = { queue, schemaCache: {} };

  queue.on("finished", (job: Job<GenJob>) => {
    log(`[job] ${job.id} ${job.state}${job.error ? ` (${job.error})` : ""}`);
  });

  // Drop a swept job's directory too, so the queue and the disk cannot disagree about
  // what exists. A download afterwards is then a clean 404 rather than a stale file.
  const sweeper = setInterval(() => {
    for (const id of queue.sweep(CONFIG.jobTtlMs)) {
      try {
        fs.rmSync(pathFor(LOCAL, "jobs", id), { recursive: true, force: true });
      } catch { /* already gone */ }
    }
  }, Math.min(CONFIG.jobTtlMs, 10 * 60 * 1000));
  sweeper.unref();

  const server = http.createServer((req, res) => {
    const started = Date.now();
    res.on("finish", () => {
      log(`${req.method} ${req.url} → ${res.statusCode} ${Date.now() - started}ms`);
    });

    void (async () => {
      try {
        if (await route(req, res, deps)) return;
        // Not an API path: try the static front end (P3 lands here).
        if (req.method === "GET" || req.method === "HEAD") {
          const url = new URL(req.url ?? "/", "http://localhost");
          if (sendStatic(res, CONFIG.publicDir, url.pathname)) return;
        }
        sendError(res, 404, "not found");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // An error carrying its own status says what it is; otherwise bad input is the
        // caller's problem (400) and anything else is ours (500). Getting that backwards
        // makes a malformed upload look like an outage.
        const carried = (err as { status?: number } | null)?.status;
        const clientFault = /empty body|JSON|bad |^not a valid|give either/i.test(message);
        const status = carried ?? (clientFault ? 400 : 500);
        if (status >= 500 && !options.quiet) console.error("[error]", err);
        if (!res.headersSent) {
          // The body is still arriving when we refuse it, so ask for the connection back
          // rather than reading the rest of something already rejected.
          res.setHeader("connection", "close");
          sendError(res, status, message);
        } else {
          res.end();
        }
      }
    })();
  });

  return {
    server,
    queue,
    deps,
    close: () => new Promise<void>((resolve) => {
      clearInterval(sweeper);
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
