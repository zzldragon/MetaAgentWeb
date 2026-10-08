// Running a generated agent — OFF by default, and deliberately hard to turn on.
//
// Everywhere else this server is careful never to execute what it produced: generated
// code is assembled from a posted graph, and running it here would make the whole
// design's safety argument circular. This module is the exception, and it is fenced.
//
// ## The fence
//
// `allowed()` must pass before anything spawns, and it requires BOTH:
//
//   * `MTA_ALLOW_RUN=1` — an explicit decision someone typed;
//   * the server bound to loopback — so enabling it cannot silently expose a remote
//     code-execution endpoint the moment someone changes MTA_HOST.
//
// The second condition matters more than the first. A flag people set once and forget
// is not a control; a flag that stops working when the threat model changes is.
//
// ## The key
//
// A generated agent ships with blank credentials, so running one needs a key. It comes
// from `MTA_RUN_API_KEY` and is passed to the CHILD PROCESS ONLY, as `AGENT_API_KEY`,
// which generated agents already honour for filling blank slots. It is never written to
// the job directory, never included in a download, and never sent to the browser.
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { CONFIG } from "./config.ts";
import { newId } from "./ids.ts";
import type { Principal } from "./principal.ts";

export type RunState = "starting" | "running" | "exited" | "failed" | "stopped";

export type Run = {
  id: string;
  jobId: string;
  ownerId: string;
  state: RunState;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  error?: string;
};

type Live = Run & {
  proc?: ChildProcess;
  /** Everything printed so far, so a late subscriber sees the run from the start. */
  buffer: string[];
  listeners: Set<(chunk: string) => void>;
  done: Set<(run: Run) => void>;
};

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_BUFFERED_CHUNKS = 2000;

const runs = new Map<string, Live>();

/** May this server run generated code at all? */
export function allowed(): { ok: true } | { ok: false; reason: string } {
  if (!CONFIG.allowRun) {
    return { ok: false, reason: "running is disabled. Set MTA_ALLOW_RUN=1 to enable it "
                                + "(loopback only) — the server executes generated code, "
                                + "so it is off unless you asked for it." };
  }
  if (!LOOPBACK.has(CONFIG.host)) {
    return { ok: false, reason: `running is refused because the server is bound to `
                                + `${CONFIG.host}, not loopback. Executing generated code `
                                + `on a reachable interface is a remote code-execution `
                                + `endpoint; MTA_ALLOW_RUN does not override this.` };
  }
  return { ok: true };
}

/** The directory holding the generated agent for a finished job, or null. */
export function agentDir(jobDir: string, name: string): string | null {
  const dir = path.join(jobDir, "out", name);
  return fs.existsSync(path.join(dir, "agent.py")) ? dir : null;
}

export function get(id: string): Run | undefined {
  const live = runs.get(id);
  return live && publicRun(live);
}

export function publicRun(live: Live): Run {
  const { proc, buffer, listeners, done, ...rest } = live;
  void proc; void buffer; void listeners; void done;
  return rest;
}

/** Everything printed so far — what a subscriber gets before the live feed. */
export function backlog(id: string): string {
  return runs.get(id)?.buffer.join("") ?? "";
}

export function subscribe(id: string, onChunk: (chunk: string) => void,
                          onDone: (run: Run) => void): () => void {
  const live = runs.get(id);
  if (!live) return () => {};
  live.listeners.add(onChunk);
  live.done.add(onDone);
  return () => { live.listeners.delete(onChunk); live.done.delete(onDone); };
}

/** Start an agent. The caller has already checked `allowed()` and ownership. */
export function start(principal: Principal, jobId: string, dir: string,
                      task: string): Run {
  const live: Live = {
    id: newId(), jobId, ownerId: principal.id, state: "starting",
    startedAt: Date.now(), buffer: [], listeners: new Set(), done: new Set(),
  };
  runs.set(live.id, live);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    // Unbuffered, or Python holds output until the process ends and a streaming view
    // shows nothing for the whole run.
    PYTHONUNBUFFERED: "1",
  };
  // Blank slots only; a graph that set ${ENV_VAR} still wins. Child process only —
  // this never lands in the job directory or the download.
  if (CONFIG.runApiKey) env.AGENT_API_KEY = CONFIG.runApiKey;
  else emit(live, "[warn] no MTA_RUN_API_KEY set — the agent will report a missing key\n");

  let proc: ChildProcess;
  try {
    proc = spawn(CONFIG.python, ["agent.py", task], {
      cwd: dir, env, windowsHide: true,
    });
  } catch (err) {
    live.state = "failed";
    live.error = err instanceof Error ? err.message : String(err);
    live.endedAt = Date.now();
    return publicRun(live);
  }

  live.proc = proc;
  live.state = "running";
  proc.stdout?.setEncoding("utf-8");
  proc.stderr?.setEncoding("utf-8");
  proc.stdout?.on("data", (chunk: string) => emit(live, chunk));
  proc.stderr?.on("data", (chunk: string) => emit(live, chunk));

  const deadline = setTimeout(() => {
    emit(live, `\n[stopped] no result after ${CONFIG.runTimeoutMs / 1000}s\n`);
    proc.kill("SIGKILL");
  }, CONFIG.runTimeoutMs);

  proc.on("error", (err) => {
    clearTimeout(deadline);
    live.state = "failed";
    live.error = err.message;
    finish(live);
  });
  proc.on("close", (code, signal) => {
    clearTimeout(deadline);
    live.exitCode = code;
    live.state = live.state === "stopped" || signal ? "stopped" : "exited";
    finish(live);
  });

  return publicRun(live);
}

export function stop(id: string): boolean {
  const live = runs.get(id);
  if (!live?.proc || live.state !== "running") return false;
  live.state = "stopped";
  live.proc.kill("SIGKILL");
  return true;
}

/** Forget runs that ended longer ago than `ttlMs`. */
export function sweep(ttlMs: number): string[] {
  const cutoff = Date.now() - ttlMs;
  const dropped: string[] = [];
  for (const [id, live] of runs) {
    if (live.endedAt !== undefined && live.endedAt < cutoff) {
      runs.delete(id);
      dropped.push(id);
    }
  }
  return dropped;
}

export function ownedBy(id: string, principal: Principal): boolean {
  return runs.get(id)?.ownerId === principal.id;
}

function emit(live: Live, chunk: string): void {
  live.buffer.push(chunk);
  // Bound the replay buffer: a runaway agent should not become a memory leak, and the
  // recent output is the part anybody reads.
  if (live.buffer.length > MAX_BUFFERED_CHUNKS) live.buffer.splice(0, 500);
  for (const fn of live.listeners) {
    try { fn(chunk); } catch { /* a dropped connection is not the run's problem */ }
  }
}

function finish(live: Live): void {
  live.endedAt = Date.now();
  live.proc = undefined;
  const snapshot = publicRun(live);
  for (const fn of live.done) {
    try { fn(snapshot); } catch { /* ditto */ }
  }
  live.listeners.clear();
  live.done.clear();
}
