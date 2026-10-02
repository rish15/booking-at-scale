// Request hash for idempotency comparison. MUST be order-independent —
// ["A12","A13"] and ["A13","A12"] are the same logical request, so a
// client retry with reordered seats is still recognized as the same
// request (see ARCHITECTURE.md Fix on request_hash).

import crypto from "crypto";

export function hashReserveRequest(seats: string[]): string {
  const sorted = [...seats].sort();
  return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}
