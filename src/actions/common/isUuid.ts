// Path params that are meant to be UUIDs are checked before they reach
// Postgres: an uncastable value ("123", "not-a-uuid") raises SQLSTATE 22P02
// from the driver, which would otherwise surface as a 500. A malformed id
// can never match a row, so it is simply "not found".
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}
