// Decision 3 of 4 — one place resolves a filesystem path.
//
// Every path in the server comes from `pathFor`. Single-user it returns
// `data/<kind>/<id>`; multi-tenant it returns `data/<tenant>/<kind>/<id>` and nothing
// else changes. Without this the tenant prefix has to be threaded through every
// `path.join` in the codebase, and the one that gets missed is a cross-tenant read.
//
// It also validates: an id that is not a well-formed opaque id never becomes a path, so
// `../../` cannot arrive from a URL.
import fs from "node:fs";
import path from "node:path";

import { CONFIG } from "./config.ts";
import { isId } from "./ids.ts";
import type { Principal } from "./principal.ts";

export type ResourceKind = "graphs" | "jobs" | "uploads";

/** The directory holding one resource. Throws on an id that is not opaque. */
export function pathFor(principal: Principal, kind: ResourceKind, id: string): string {
  if (!isId(id)) throw new Error(`not a valid ${kind} id`);
  // v1: no tenant segment. v2: path.join(CONFIG.dataDir, principal.id, kind, id)
  void principal;
  return path.join(CONFIG.dataDir, kind, id);
}

/** The directory holding all of one kind for this principal. */
export function dirFor(principal: Principal, kind: ResourceKind): string {
  void principal;                                    // v2: adds principal.id here
  return path.join(CONFIG.dataDir, kind);
}

/** Create (if needed) and return a resource directory. */
export function ensureFor(principal: Principal, kind: ResourceKind, id: string): string {
  const dir = pathFor(principal, kind, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Resolve a path INSIDE a resource directory, refusing anything that escapes it.
 *
 * Used for download-a-named-file, where the name comes from the client. Checking the
 * resolved prefix is what makes `..%2f..%2fconfig.json` a 400 rather than a file read.
 */
export function within(base: string, relative: string): string | null {
  const full = path.resolve(base, relative);
  const root = path.resolve(base);
  return full === root || full.startsWith(root + path.sep) ? full : null;
}
