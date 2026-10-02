import { BadRequestError } from "../../../errors";
import { ReserveSeatsBody } from "../../../types";

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

  return { seats: seats as string[], idempotency_key };
}
