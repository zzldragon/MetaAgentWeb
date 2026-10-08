// The bridge to MetaAgent: spawn `python mta_gen.py`, parse one JSON object.
//
// This is the whole Python dependency of the server. It never imports Python, never
// keeps an interpreter alive, and never runs generated code — it starts a process,
// reads stdout, and lets the process die.
//
// `mta_gen.py` guarantees stdout is a single JSON object and nothing else (everything
// human goes to stderr), so no banner-stripping is needed here. When that guarantee is
// broken the failure is loud rather than a silently mangled parse — see `parseResult`.

import { spawn } from "node:child_process";

import { CONFIG, genScript, schemaScript } from "./config.ts";

/** What `mta_gen.py` prints. Optional fields are absent, not null. */
export type GenResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  mode?: string;
  entry?: string;
  pipeline?: string[];
  name?: string;
  out_dir?: string;
  files?: { path: string; bytes: number }[];
  bytes?: number;
  zip?: string;
  zip_bytes?: number;
  zip_skipped?: string[];
  tools_restored?: string[];
  props_defaulted?: number;
  scrubbed?: number;
  findings?: { severity: string; message: string; target: string;
               source: string; detail: string }[];
  estimate_summary?: string;
};

export type GenOptions = {
  /** Exactly one of these. */
  graphPath?: string;
  mtaPath?: string;
  outDir: string;
  /** Where the graph's tool .py files live. Defaults to <outDir>/_tools inside the CLI. */
  toolsDir?: string;
  name?: string;
  target?: "python" | "ts";
  codeStyle?: "single" | "package";
  analyzeOnly?: boolean;
  estimate?: boolean;
  scrub?: boolean;
  zip?: boolean;
  signal?: AbortSignal;
};

export class PythonError extends Error {
  // Declared explicitly rather than as a constructor parameter property: Node runs this
  // file by STRIPPING types, and a parameter property is syntax that would have to be
  // rewritten, not removed. tsconfig sets erasableSyntaxOnly to catch it at edit time.
  readonly stderr: string;

  constructor(message: string, stderr: string = "") {
    super(message);
    this.name = "PythonError";
    this.stderr = stderr;
  }
}

function argsFor(options: GenOptions): string[] {
  const args = [genScript()];
  if (options.graphPath) args.push("--graph", options.graphPath);
  else if (options.mtaPath) args.push("--mta", options.mtaPath);
  else throw new Error("give either graphPath or mtaPath");
  args.push("--out", options.outDir);
  if (options.toolsDir) args.push("--tools", options.toolsDir);
  if (options.name) args.push("--name", options.name);
  if (options.target) args.push("--target", options.target);
  if (options.codeStyle) args.push("--code-style", options.codeStyle);
  if (options.analyzeOnly) args.push("--analyze-only");
  if (options.estimate) args.push("--estimate");
  if (options.scrub) args.push("--scrub");
  if (options.zip) {
    args.push("--zip");
    if (CONFIG.zipSkipOverBytes > 0) {
      args.push("--zip-skip-over", String(CONFIG.zipSkipOverBytes));
    }
  }
  return args;
}

function parseResult(stdout: string, stderr: string, code: number | null): GenResult {
  const text = stdout.trim();
  if (!text) {
    throw new PythonError(
      `mta_gen produced no output (exit ${code}). Check MTA_PYTHON and MTA_ROOT.`, stderr);
  }
  try {
    return JSON.parse(text) as GenResult;
  } catch {
    // The CLI's contract is one JSON object on stdout. Reaching here means it printed
    // something else -- almost always a Python traceback from an import failure, which
    // is worth surfacing verbatim rather than as "unexpected token".
    throw new PythonError(
      `mta_gen did not print JSON (exit ${code}): ${text.slice(0, 300)}`, stderr);
  }
}

/** Run a generation. Resolves with the CLI's report even when `ok` is false. */
export function generate(options: GenOptions): Promise<GenResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(CONFIG.python, argsFor(options), {
      cwd: CONFIG.metaagent,
      // Inherit only what Python needs; the server's own env is not the job's business.
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    // A hard wall-clock cap. A pathological graph should cost one job slot for a bounded
    // time, not the slot forever -- which is the other half of why this is a subprocess.
    const timer = setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, CONFIG.jobTimeoutMs);

    const onAbort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    child.on("error", (err) => done(() => reject(
      new PythonError(`could not start ${CONFIG.python}: ${err.message}`, stderr))));

    child.on("close", (code, signal) => done(() => {
      if (signal) {
        reject(new PythonError(
          options.signal?.aborted ? "cancelled" : `timed out after ${CONFIG.jobTimeoutMs}ms`,
          stderr));
        return;
      }
      try {
        resolve(parseResult(stdout, stderr, code));
      } catch (err) {
        reject(err);
      }
    }));
  });
}

/** Validate without generating — what the canvas calls on every edit. */
export function analyze(graphPath: string, outDir: string, toolsDir?: string,
                        signal?: AbortSignal): Promise<GenResult> {
  return generate({ graphPath, outDir, toolsDir, analyzeOnly: true, signal });
}

/** The node registry, straight from `mta_schema.py`. */
export function schema(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(CONFIG.python, [schemaScript()], {
      cwd: CONFIG.metaagent,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (c: string) => { stdout += c; });
    child.stderr.on("data", (c: string) => { stderr += c; });
    child.on("error", (err) => reject(new PythonError(err.message, stderr)));
    child.on("close", (code) => {
      if (code === 0 && stdout.trim()) resolve(stdout);
      else reject(new PythonError(`mta_schema failed (exit ${code})`, stderr));
    });
  });
}
