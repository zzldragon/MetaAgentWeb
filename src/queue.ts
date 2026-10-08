// Decision 4 of 4 — the job queue is a component with a POLICY hook, not `spawn()`
// inline in a request handler.
//
// v1's policy is "at most N running at once". v2's is "at most N per tenant, and stop
// once they are over quota". Because admission is one function rather than an `if` in
// the handler, that is a change to `admit` — not to the request path.
//
// The queue also owns the lifecycle a server needs and a bare spawn does not: a job
// that is queued but not yet started can be cancelled, a finished job is retained long
// enough to be collected and no longer, and the process learns about failures rather
// than losing them into a floating promise.
import { EventEmitter } from "node:events";

import { newId } from "./ids.ts";
import type { Principal } from "./principal.ts";

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export type Job<R = unknown> = {
  id: string;
  ownerId: string;
  kind: string;
  state: JobState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: R;
  error?: string;
};

/** Decides whether a principal may start another job right now. */
export type AdmissionPolicy = (principal: Principal, running: Job[], queued: Job[])
  => { ok: true } | { ok: false; reason: string };

/**
 * v1: a single global concurrency cap.
 *
 * v2 replaces this with a per-tenant version — the signature already carries the
 * principal and the current queues, which is everything a quota needs.
 */
export const concurrencyPolicy = (max: number): AdmissionPolicy =>
  (_principal, running, queued) =>
    running.length + queued.length < max * 4
      ? { ok: true }
      : { ok: false, reason: `too many jobs in flight (limit ${max * 4})` };

export type Runner<R> = (job: Job<R>, signal: AbortSignal) => Promise<R>;

export class JobQueue<R = unknown> extends EventEmitter {
  #jobs = new Map<string, Job<R>>();
  #controllers = new Map<string, AbortController>();
  #pending: string[] = [];
  #running = new Set<string>();

  // Explicit fields, not constructor parameter properties: Node strips types rather
  // than compiling them, and a parameter property is a rewrite it will not do.
  readonly #runner: Runner<R>;
  readonly #maxConcurrent: number;
  readonly #admit: AdmissionPolicy;

  constructor(runner: Runner<R>, maxConcurrent: number, admit: AdmissionPolicy) {
    super();
    this.#runner = runner;
    this.#maxConcurrent = maxConcurrent;
    this.#admit = admit;
  }

  #byState(state: JobState): Job<R>[] {
    return [...this.#jobs.values()].filter((j) => j.state === state);
  }

  /** Queue a job, or refuse it. The refusal is a value, not an exception. */
  submit(principal: Principal, kind: string):
    { ok: true; job: Job<R> } | { ok: false; reason: string } {
    const verdict = this.#admit(principal, this.#byState("running"), this.#byState("queued"));
    if (!verdict.ok) return verdict;

    const job: Job<R> = {
      id: newId(),
      ownerId: principal.id,
      kind,
      state: "queued",
      createdAt: Date.now(),
    };
    this.#jobs.set(job.id, job);
    this.#pending.push(job.id);
    queueMicrotask(() => this.#pump());
    return { ok: true, job };
  }

  get(id: string): Job<R> | undefined {
    return this.#jobs.get(id);
  }

  list(ownerId: string): Job<R>[] {
    return [...this.#jobs.values()].filter((j) => j.ownerId === ownerId);
  }

  /** Cancel a job. A queued one never starts; a running one is aborted. */
  cancel(id: string): boolean {
    const job = this.#jobs.get(id);
    if (!job || job.state === "done" || job.state === "failed") return false;
    if (job.state === "queued") {
      this.#pending = this.#pending.filter((p) => p !== id);
      job.state = "cancelled";
      job.finishedAt = Date.now();
      this.emit("finished", job);
      return true;
    }
    this.#controllers.get(id)?.abort();
    return true;
  }

  /** Forget jobs that finished longer ago than `ttlMs`. Returns the ids dropped. */
  sweep(ttlMs: number): string[] {
    const cutoff = Date.now() - ttlMs;
    const dropped: string[] = [];
    for (const [id, job] of this.#jobs) {
      if (job.finishedAt !== undefined && job.finishedAt < cutoff) {
        this.#jobs.delete(id);
        this.#controllers.delete(id);
        dropped.push(id);
      }
    }
    return dropped;
  }

  #pump(): void {
    while (this.#running.size < this.#maxConcurrent && this.#pending.length > 0) {
      const id = this.#pending.shift();
      if (id === undefined) return;
      const job = this.#jobs.get(id);
      if (!job || job.state !== "queued") continue;
      void this.#start(job);
    }
  }

  async #start(job: Job<R>): Promise<void> {
    const controller = new AbortController();
    this.#controllers.set(job.id, controller);
    this.#running.add(job.id);
    job.state = "running";
    job.startedAt = Date.now();
    this.emit("started", job);
    try {
      job.result = await this.#runner(job, controller.signal);
      job.state = controller.signal.aborted ? "cancelled" : "done";
    } catch (err) {
      job.state = controller.signal.aborted ? "cancelled" : "failed";
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      job.finishedAt = Date.now();
      this.#running.delete(job.id);
      this.#controllers.delete(job.id);
      this.emit("finished", job);
      this.#pump();
    }
  }
}
