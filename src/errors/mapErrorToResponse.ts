// Shared by baseController (errors thrown inside a controller's try/catch)
// and the Fastify global error handler (errors thrown from preHandler
// hooks — auth, admin-auth — which never reach a controller at all). One
// mapping, not two copies that could drift.

import {
  ResourceNotFoundError,
  BadRequestError,
  NotAuthorizedError,
  NotAuthenticatedError,
  ReservationDeclinedError,
  OverloadedError,
} from "./error";

export interface ErrorResponse {
  status: number;
  body: Record<string, unknown>;
}

export function mapErrorToResponse(err: unknown): ErrorResponse {
  if (err instanceof ResourceNotFoundError) {
    return { status: 404, body: { type: "error", message: err.message } };
  }
  if (err instanceof BadRequestError) {
    return { status: 400, body: { type: "error", message: err.message } };
  }
  if (err instanceof NotAuthorizedError) {
    return { status: 403, body: { type: "error", message: err.message } };
  }
  if (err instanceof NotAuthenticatedError) {
    return { status: 401, body: { type: "error", message: err.message } };
  }
  if (err instanceof ReservationDeclinedError) {
    return {
      status: 409,
      body: { type: "error", reason: err.reason, message: err.message, seats: err.seats },
    };
  }
  if (err instanceof OverloadedError) {
    return { status: 429, body: { type: "error", message: err.message } };
  }
  const error = err instanceof Error ? err : new Error(String(err));
  // eslint-disable-next-line no-console
  console.error("Unhandled error:", error);
  return { status: 500, body: { type: "error", message: "Internal server error" } };
}
