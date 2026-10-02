// Same DomainError hierarchy shape as the template, translated to TS.
// baseController maps these to HTTP status codes — handlers/actions only
// ever throw, never touch the HTTP layer themselves.

export class DomainError extends Error {
  data?: unknown;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ResourceNotFoundError extends DomainError {
  constructor(resource: string, query?: unknown) {
    super(`Resource ${resource} was not found.`);
    this.data = { resource, query };
  }
}

export class BadRequestError extends DomainError {
  constructor(error: string) {
    super(error);
    this.data = { error };
  }
}

export class NotAuthorizedError extends DomainError {
  constructor(error: string) {
    super(`Access Forbidden: ${error}`);
    this.data = { error };
  }
}

export class NotAuthenticatedError extends DomainError {
  constructor(error: string) {
    super(`Not Authenticated: ${error}`);
    this.data = { error };
  }
}

// The one addition over the template: the correctness bar in this exercise
// is graded in terms of 409 declines, not generic 400s. Each carries a
// `reason` that the metrics layer also uses to label
// reservations_declined_total{reason}.
export type DeclineReason = "seat_taken" | "per_user_limit" | "idempotent_conflict";

export class ReservationDeclinedError extends DomainError {
  reason: DeclineReason;
  seats?: string[];

  constructor(reason: DeclineReason, message: string, seats?: string[]) {
    super(message);
    this.reason = reason;
    this.seats = seats;
    this.data = { reason, seats };
  }
}

export class InternalError extends DomainError {
  constructor(error: Error) {
    super(error.message);
    this.data = { error };
  }
}

// Postgres timeout errors (statement_timeout / lock_timeout) must never
// surface as a bare 500 — see ARCHITECTURE.md §6. This is thrown by the
// db layer when it recognizes one of those SQLSTATE codes.
export class OverloadedError extends DomainError {
  constructor(message = "Service is busy, please retry") {
    super(message);
  }
}
