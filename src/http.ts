// Request/response helpers. No framework — node:http is enough for this API surface,
// and a dependency-free server matches the thing it serves.
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export type Res = ServerResponse<IncomingMessage>;

export function sendJson(res: Res, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    // This API is same-origin only. Saying so explicitly matters more than usual here:
    // a permissive CORS header would let any page in the browser drive a local
    // code generator.
    "x-content-type-options": "nosniff",
  });
  res.end(text);
}

export const sendError = (res: Res, status: number, message: string): void =>
  sendJson(res, status, { error: message });

/** Thrown when a request body exceeds its cap. Carries the status it deserves. */
export class TooLarge extends Error {
  readonly status = 413;

  constructor(limit: number) {
    super(`body larger than ${limit} bytes`);
    this.name = "TooLarge";
  }
}

/**
 * Read a request body, refusing anything over `limit`.
 *
 * The cap is enforced as chunks ARRIVE, not after: buffering an unbounded upload and
 * then measuring it is how a server runs out of memory being told about it.
 */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // PAUSE rather than destroy: stop reading immediately, but leave the socket
        // alive long enough to answer 413. Destroying here is safe but rude -- the
        // client sees a dropped connection and cannot tell a size limit from a crash.
        req.pause();
        reject(new TooLarge(limit));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function readJsonBody<T>(req: IncomingMessage, limit: number): Promise<T> {
  const raw = await readBody(req, limit);
  if (raw.length === 0) throw new Error("empty body");
  return JSON.parse(raw.toString("utf-8")) as T;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** Serve a file from `root`, or return false if the path escapes it / is missing. */
export function sendStatic(res: Res, root: string, urlPath: string): boolean {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, "") || "index.html";
  const full = path.resolve(root, rel);
  // The same containment check the resource paths use: a static route is the classic
  // way `../../` gets read off disk.
  if (full !== path.resolve(root) && !full.startsWith(path.resolve(root) + path.sep)) {
    return false;
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return false;
  res.writeHead(200, {
    "content-type": MIME[path.extname(full).toLowerCase()] ?? "application/octet-stream",
    "content-length": fs.statSync(full).size,
    "x-content-type-options": "nosniff",
  });
  fs.createReadStream(full).pipe(res);
  return true;
}

/** Stream a file as a download. */
export function sendDownload(res: Res, file: string, filename: string,
                             contentType = "application/octet-stream"): void {
  const stat = fs.statSync(file);
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": stat.size,
    // The filename is quoted and stripped of anything that could break out of the
    // header; it reaches a Save dialog, not a shell, but a newline here is a header
    // injection.
    "content-disposition": `attachment; filename="${filename.replace(/[^\w.\-]/g, "_")}"`,
  });
  fs.createReadStream(file).pipe(res);
}
