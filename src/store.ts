// Saved graphs, on disk, owned.
//
// Every record carries an `ownerId` and every read checks it, even though there is one
// principal today. The check is the cheap half of multi-tenancy; leaving it out is what
// makes the expensive half a security review.
//
// A graph is stored as its own directory so an upload's tool files can live beside it:
//
//   data/graphs/<id>/meta.json     { id, ownerId, name, createdAt, updatedAt }
//                   /graph.json    the graph itself
//                   /source.mta    the upload it came from, when it came from one
import fs from "node:fs";
import path from "node:path";

import { newId } from "./ids.ts";
import { ensureFor, dirFor, pathFor } from "./paths.ts";
import { owns } from "./principal.ts";
import type { Principal } from "./principal.ts";

export type GraphMeta = {
  id: string;
  ownerId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Present when the graph arrived as a .mta upload. */
  hasSource?: boolean;
};

const metaPath = (dir: string) => path.join(dir, "meta.json");
const graphPath = (dir: string) => path.join(dir, "graph.json");
export const sourcePath = (dir: string) => path.join(dir, "source.mta");

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  // Write-then-rename: a crash mid-write leaves the previous version intact rather than
  // a truncated file that fails to parse on the next read.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

/** Create a graph. Returns its metadata. */
export function create(principal: Principal, name: string, graph: unknown,
                       source?: Buffer): GraphMeta {
  const id = newId();
  const dir = ensureFor(principal, "graphs", id);
  const now = Date.now();
  const meta: GraphMeta = {
    id, ownerId: principal.id, name: name || "Untitled",
    createdAt: now, updatedAt: now,
  };
  if (source) {
    fs.writeFileSync(sourcePath(dir), source);
    meta.hasSource = true;
  }
  writeJson(graphPath(dir), graph);
  writeJson(metaPath(dir), meta);
  return meta;
}

/** One graph's metadata, or null when it is missing OR not this principal's. */
export function meta(principal: Principal, id: string): GraphMeta | null {
  let dir: string;
  try {
    dir = pathFor(principal, "graphs", id);
  } catch {
    return null;                                   // malformed id: not found, not a 500
  }
  const found = readJson<GraphMeta>(metaPath(dir));
  // Missing and forbidden are the SAME answer on purpose: distinguishing them tells an
  // unauthorised caller which ids exist.
  return found && owns(principal, found.ownerId) ? found : null;
}

/** The graph itself, or null. */
export function read(principal: Principal, id: string): unknown | null {
  if (!meta(principal, id)) return null;
  return readJson<unknown>(graphPath(pathFor(principal, "graphs", id)));
}

/** The on-disk path of a graph's `graph.json`, for handing to the generator. */
export function fileOf(principal: Principal, id: string): string | null {
  if (!meta(principal, id)) return null;
  return graphPath(pathFor(principal, "graphs", id));
}

/** The .mta an uploaded graph came from, if any. */
export function sourceOf(principal: Principal, id: string): string | null {
  const found = meta(principal, id);
  if (!found?.hasSource) return null;
  const file = sourcePath(pathFor(principal, "graphs", id));
  return fs.existsSync(file) ? file : null;
}

/** Replace a graph's content. Returns the updated metadata, or null. */
export function update(principal: Principal, id: string, graph: unknown,
                       name?: string): GraphMeta | null {
  const found = meta(principal, id);
  if (!found) return null;
  const dir = pathFor(principal, "graphs", id);
  writeJson(graphPath(dir), graph);
  const next: GraphMeta = { ...found, updatedAt: Date.now() };
  if (name) next.name = name;
  writeJson(metaPath(dir), next);
  return next;
}

/** Every graph this principal owns, newest first. */
export function list(principal: Principal): GraphMeta[] {
  const root = dirFor(principal, "graphs");
  if (!fs.existsSync(root)) return [];
  const out: GraphMeta[] = [];
  for (const entry of fs.readdirSync(root)) {
    const found = readJson<GraphMeta>(metaPath(path.join(root, entry)));
    if (found && owns(principal, found.ownerId)) out.push(found);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Delete a graph. Returns whether it existed and belonged to this principal. */
export function remove(principal: Principal, id: string): boolean {
  if (!meta(principal, id)) return false;
  fs.rmSync(pathFor(principal, "graphs", id), { recursive: true, force: true });
  return true;
}
