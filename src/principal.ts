// Decision 1 of 4 — every request carries a principal.
//
// In this version there is exactly one, `local`, and no login. That is the point: the
// SHAPE is multi-tenant from day one even though the population is one. Every handler
// receives a Principal and every lookup goes through it, so turning on real accounts
// later means changing where the principal comes from — not auditing each endpoint for
// somewhere that assumed the caller owned what it asked for.
//
// Retrofitting the other way round is how IDOR bugs ship: the endpoints all work, they
// simply never asked whose data it was.
//
// To go multi-tenant: make `principalOf` read a token and resolve it against
// `codegen_ts/runtime_ts/userdb.ts` (428 lines, zero deps, node:sqlite + scrypt, already
// written and tested in MetaAgent). Nothing else in this file's callers changes.
import type { IncomingMessage } from "node:http";

export type Principal = {
  /** Stable id used for ownership and path scoping. Never shown to the user. */
  id: string;
  /** Display name. */
  name: string;
  /** Reserved for a later admin split; every v1 caller is an owner. */
  role: "owner" | "admin";
};

export const LOCAL: Principal = { id: "local", name: "local", role: "owner" };

/** Who is making this request. Single-user: always `local`. */
export function principalOf(_req: IncomingMessage): Principal {
  return LOCAL;
}

/** Does `principal` own a record carrying `ownerId`? */
export function owns(principal: Principal, ownerId: string | undefined): boolean {
  return ownerId !== undefined && ownerId === principal.id;
}
