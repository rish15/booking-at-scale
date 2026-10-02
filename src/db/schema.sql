-- Replaces Sequelize's migrations/ folder. No ORM, no version-tracking
-- table, no up/down pairs — the schema is fixed upfront for this exercise,
-- so a single idempotent script is the right amount of ceremony (see the
-- "migrations" discussion in ARCHITECTURE.md / conversation history).
-- Safe to re-run: every statement is guarded with IF NOT EXISTS.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

CREATE TABLE IF NOT EXISTS shows (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  price_paise    INTEGER NOT NULL CHECK (price_paise >= 0),
  per_user_limit INTEGER NOT NULL DEFAULT 4 CHECK (per_user_limit > 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seats (
  show_id    UUID NOT NULL REFERENCES shows(id),
  seat_code  TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'available'
             CHECK (status IN ('available', 'held', 'confirmed')),
  held_by    TEXT,              -- single source of truth for "who holds this seat"
  expires_at TIMESTAMPTZ,
  PRIMARY KEY (show_id, seat_code)
);

CREATE TABLE IF NOT EXISTS reservations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id         UUID NOT NULL REFERENCES shows(id),
  user_id         TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  amount_paise    INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Scoped to user_id so two different users can never collide on the same
  -- idempotency key string (see ARCHITECTURE.md Fix 1).
  UNIQUE (show_id, user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS reservation_seats (
  reservation_id UUID NOT NULL REFERENCES reservations(id),
  seat_code      TEXT NOT NULL,
  PRIMARY KEY (reservation_id, seat_code)
);

-- Supports the per-user-limit COUNT in reserveSeats.ts (ARCHITECTURE.md
-- Fix 2). Without this, that query is a sequential scan over every seat in
-- the show on every single reserve call.
CREATE INDEX IF NOT EXISTS idx_seats_user_holds
  ON seats (show_id, held_by)
  WHERE status IN ('held', 'confirmed');
