import { BadRequestError } from "../../../errors";
import { ReserveSeatsBody } from "../../../types";

// Stored and indexed per request, so unbounded client strings are a
// storage/abuse vector; generous but finite caps.
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_SEAT_CODE_LENGTH = 32;

export function validateReserveBody(body: unknown): ReserveSeatsBody {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body missing");
  }
  const { seats, idempotency_key } = body as Record<string, unknown>;

  if (!Array.isArray(seats) || seats.length === 0) {
    throw new BadRequestError("seats must be a non-empty array of seat codes");
  }
  if (!seats.every((s) => typeof s === "string" && s.length > 0)) {
    throw new BadRequestError("seats must all be non-empty strings");
  }
  if (new Set(seats).size !== seats.length) {
    throw new BadRequestError("seats must not contain duplicates");
  }
  if (typeof idempotency_key !== "string" || idempotency_key.length === 0) {
    throw new BadRequestError("idempotency_key is required");
  }
  if (idempotency_key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new BadRequestError(`idempotency_key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
  }
  if (seats.some((s) => (s as string).length > MAX_SEAT_CODE_LENGTH)) {
    throw new BadRequestError(`seat codes must be at most ${MAX_SEAT_CODE_LENGTH} characters`);
  }

  return { seats: seats as string[], idempotency_key };
}
