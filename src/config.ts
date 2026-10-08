// Server configuration. Everything is an env override with a working default, so the
// single-user case needs no config file at all.
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");

const env = (name: string, fallback: string): string =>
  (process.env[name] ?? "").trim() || fallback;
const envInt = (name: string, fallback: number): number => {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const CONFIG = {
  // Loopback by DEFAULT, deliberately. This server turns a posted graph into runnable
  // code; on 0.0.0.0 that is a code-generation service open to the network. Binding
  // wider must be a decision someone typed, not something they inherited.
  host: env("MTA_HOST", "127.0.0.1"),
  port: envInt("MTA_PORT", 8722),

  // Where MetaAgent lives, and which interpreter runs it.
  metaagent: env("MTA_ROOT", path.resolve(ROOT, "..", "MetaAgent")),
  python: env("MTA_PYTHON", "python"),

  // Per-user working state: saved graphs, uploads, job output.
  dataDir: env("MTA_DATA", path.join(ROOT, "data")),
  publicDir: path.join(ROOT, "public"),

  // Job limits. A generation is CPU- and disk-bound and takes seconds; these bound the
  // damage a pathological graph can do without getting in a real one's way.
  maxConcurrentJobs: envInt("MTA_JOBS", 2),
  jobTimeoutMs: envInt("MTA_JOB_TIMEOUT_MS", 120_000),
  jobTtlMs: envInt("MTA_JOB_TTL_MS", 60 * 60 * 1000),

  // Upload ceiling. A .mta is a zip of JSON and a few .py files; megabytes, not tens.
  maxUploadBytes: envInt("MTA_MAX_UPLOAD", 32 * 1024 * 1024),

  // Running a generated agent. OFF unless explicitly enabled, and refused anyway when
  // the server is not on loopback -- see src/run.ts for why the second condition is the
  // one that matters. The key is passed to the child process only, never written down.
  allowRun: (process.env.MTA_ALLOW_RUN ?? "").trim() === "1",
  runApiKey: (process.env.MTA_RUN_API_KEY ?? "").trim(),
  runTimeoutMs: envInt("MTA_RUN_TIMEOUT_MS", 300_000),

  // Files bigger than this are left out of a download. codegen copies rg.exe (5.4 MB)
  // in beside any ripgrep-using toolset, which is 96% of a scoutXCode zip and almost
  // never what someone waited for. 0 = include everything.
  zipSkipOverBytes: envInt("MTA_ZIP_SKIP_OVER", 2_000_000),
} as const;

export const genScript = (): string => path.join(CONFIG.metaagent, "mta_gen.py");
export const schemaScript = (): string => path.join(CONFIG.metaagent, "mta_schema.py");
