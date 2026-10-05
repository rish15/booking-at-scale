import { BadRequestError } from "../../../errors";
import { CreateShowBody } from "../../../types";

export function validateCreateShowBody(body: unknown): CreateShowBody {
  if (!body || typeof body !== "object") {
    throw new BadRequestError("Request body missing");
  }
  const { name, seats, price_paise, per_user_limit } = body as Record<string, unknown>;

  if (typeof name !== "string" || name.length === 0) {
    throw new BadRequestError("name is required");
  }
  if (!Array.isArray(seats) || seats.length === 0) {
    throw new BadRequestError("seats must be a non-empty array of seat codes");
  }
  if (!seats.every((s) => typeof s === "string" && s.length > 0)) {
    throw new BadRequestError("seats must all be non-empty strings");
  }
  if (seats.some((s) => (s as string).length > 32)) {
    throw new BadRequestError("seat codes must be at most 32 characters");
  }
  if (new Set(seats).size !== seats.length) {
    throw new BadRequestError("seats must not contain duplicates");
  }
  if (typeof price_paise !== "number" || !Number.isInteger(price_paise) || price_paise < 0) {
    throw new BadRequestError("price_paise must be a non-negative integer (paise, never floats)");
  }
  if (
    per_user_limit !== undefined &&
    (typeof per_user_limit !== "number" || !Number.isInteger(per_user_limit) || per_user_limit <= 0)
  ) {
    throw new BadRequestError("per_user_limit must be a positive integer when provided");
  }

  return {
    name,
    seats: seats as string[],
    price_paise,
    per_user_limit: per_user_limit as number | undefined,
  };
}
