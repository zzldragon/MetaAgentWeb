// MetaAgent's tool library, offered to the browser.
//
// A Tool node names `.py` files; codegen inlines them into the generated agent. The
// desktop designer picks them from MetaAgent's own `tools/` folder, and until now the
// browser had no equivalent — so a Tool node was unusable from the web: you could not
// discover a filename, and even typing the right one failed, because the job's tools
// directory was empty and codegen threw a bare FileNotFoundError.
//
// Two jobs, both here:
//
//   * `list()`  — what the library holds, so the panel can offer a choice;
//   * `stage()` — copy the files a graph actually references into that job's own tools
//                 directory, so generation can find them.
//
// Copying rather than pointing the job at the shared folder is the same isolation rule
// the rest of the server follows: a job gets its own directory and cannot disturb, or be
// disturbed by, anything outside it.
import fs from "node:fs";
import path from "node:path";

import { CONFIG } from "./config.ts";

export type ToolFile = { name: string; bytes: number };

export const libraryDir = (): string => path.join(CONFIG.metaagent, "tools");

/** Every `.py` in MetaAgent's tools folder, alphabetically. */
export function list(): ToolFile[] {
  const dir = libraryDir();
  if (!fs.existsSync(dir)) return [];
  const out: ToolFile[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    // Underscore-private modules are helpers, not tool files a node should reference.
    if (!name.endsWith(".py") || name.startsWith("_")) continue;
    try {
      out.push({ name, bytes: fs.statSync(path.join(dir, name)).size });
    } catch { /* vanished between readdir and stat */ }
  }
  return out;
}

/** The `.py` names a graph's Tool nodes reference, de-duplicated. */
export function referenced(graph: unknown): string[] {
  const nodes = (graph as { nodes?: { kind?: string; props?: { files?: unknown } }[] })
    ?.nodes ?? [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (node?.kind !== "tool") continue;
    const files = node.props?.files;
    if (!Array.isArray(files)) continue;
    for (const entry of files) {
      // basename: the name reaches path.join, and it came from a browser.
      const name = path.basename(String(entry ?? "")).trim();
      if (name.endsWith(".py")) seen.add(name);
    }
  }
  return [...seen];
}

/**
 * Copy the tool files a graph needs into `destDir`.
 *
 * Returns what it copied and what it could not find. A missing file is reported rather
 * than thrown: `mta_gen` will refuse the graph anyway with a message naming it, and
 * having one place say so is better than two disagreeing.
 */
export function stage(graph: unknown, destDir: string):
  { copied: string[]; missing: string[] } {
  const copied: string[] = [];
  const missing: string[] = [];
  const names = referenced(graph);
  if (names.length === 0) return { copied, missing };

  fs.mkdirSync(destDir, { recursive: true });
  for (const name of names) {
    const from = path.join(libraryDir(), name);
    // Containment check even after basename(): the library path is configuration, and
    // a symlink or an odd MTA_ROOT should not be able to reach outside it.
    if (!path.resolve(from).startsWith(path.resolve(libraryDir()) + path.sep)
        || !fs.existsSync(from)) {
      missing.push(name);
      continue;
    }
    try {
      fs.copyFileSync(from, path.join(destDir, name));
      copied.push(name);
    } catch {
      missing.push(name);
    }
  }
  return { copied, missing };
}
