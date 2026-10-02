// Maps Postgres SQLSTATE codes raised by statement_timeout / lock_timeout
// (see ARCHITECTURE.md §6) to a domain error the controller layer already
// knows how to turn into 409/429 — never a bare 500. Call this on any error
// caught from a DB call before deciding how to respond.

import { OverloadedError } from "../errors";

const TIMEOUT_SQLSTATES = new Set([
  "57014", // query_canceled (statement_timeout)
  "55P03", // lock_not_available (lock_timeout)
]);

export function translatePgError(err: unknown): Error {
  const code = (err as { code?: string } | undefined)?.code;
  if (code && TIMEOUT_SQLSTATES.has(code)) {
    return new OverloadedError();
  }
  return err instanceof Error ? err : new Error(String(err));
}
