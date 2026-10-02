# Execution plan — Seat Reservation at Scale

Working incrementally, smallest coherent piece at a time, committing as
each lands. Correctness (no double-sell, idempotency, per-user limit,
zero 5xx) comes before deploy/observability polish.

## 1. Project setup
- [ ] package.json, tsconfig.json, .eslintrc, .gitignore
- [ ] .env.example

## 2. Foundations
- [ ] Config module (env-validated, fails fast on missing vars)
- [ ] Domain error hierarchy
- [ ] DB pool + transaction helper (withTransaction, rollback-on-every-path)
- [ ] Postgres timeout error → domain error translation
- [ ] Shared error → HTTP status mapping
- [ ] Schema (shows, seats, reservations, reservation_seats + the index
      the per-user-limit query needs)
- [ ] Migration runner
- [ ] Shared types

## 3. Cross-cutting middleware
- [ ] Structured request logging (correlation id)
- [ ] User auth (stateless bearer token)
- [ ] Admin auth (POST /shows)
- [ ] Prometheus metrics setup

## 4. Show creation + read
- [ ] Create-show request validation
- [ ] createShow action
- [ ] getShow action (per-seat status, counts, reconciliation tally)
- [ ] Show controller
- [ ] Show routes

## 5. The critical path — reservations
- [ ] Reserve-request validation + order-independent request hash
- [ ] reserveSeats action: idempotency check
- [ ] reserveSeats action: per-user limit (advisory lock + live count)
- [ ] reserveSeats action: seat acquisition (conditional UPDATE, sorted
      order, all-or-nothing)
- [ ] cancelReservation action (owner-only, idempotent)
- [ ] Reservation controller
- [ ] Reservation routes

## 6. Wiring
- [ ] Health/readiness/metrics routes
- [ ] Fastify app bootstrap (global error handler, 0.0.0.0 bind)

## 7. Containerization
- [ ] Dockerfile (multi-stage)
- [ ] docker-compose (Postgres + local PgBouncer for dev parity)

## 8. Tooling
- [ ] Token-generation script
- [ ] Burst/stampede script (hot-seat storm + reconciliation check)

## 9. Local verification
- [ ] Run migration, boot the app, smoke-test every endpoint by hand
- [ ] Run a reduced-scale burst locally, confirm zero 5xx + reconciliation holds

## 10. Documentation
- [ ] ARCHITECTURE.md
- [ ] WRITEUP.md
- [ ] SETUP (Render + Neon deployment checklist)
- [ ] README

## 11. Deploy (not yet done)
- [ ] Neon project + schema applied
- [ ] Render service pointed at Neon's pooled connection string
- [ ] Confirm cold-start survival on the live URL
- [ ] Run the full-scale burst script against the live URL
- [ ] Fill in the live URL in README
