// Decision 2 of 4 — resources are addressed by an OPAQUE id, never a name or a counter.
//
// A sequential job id is enumerable: with one tenant that is merely untidy, with two it
// is a way to read someone else's build. Making them unguessable now costs one function
// call; making them unguessable later costs a migration plus however long the window
// stayed open.
//
// `randomUUID` is cryptographically random (node:crypto), so an id is safe to put in a
// URL and safe to be the only thing standing between two users' output — though it is
// never the ONLY thing here: ownership is checked as well (see store.ts).
import { randomUUID } from "node:crypto";

/** A fresh opaque id. */
export const newId = (): string => randomUUID();

// Ids reach the filesystem via paths.ts, so they are validated on the way back IN.
// A caller-supplied id is untrusted input, whatever generated the original.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is this a well-formed id? Rejects traversal, separators and empty strings. */
export const isId = (value: unknown): value is string =>
  typeof value === "string" && UUID_RE.test(value);
