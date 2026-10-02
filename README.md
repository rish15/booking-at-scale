# booking-at-scale — Seat Reservation at Scale

Paytm Money backend take-home: a seat-reservation API that stays correct
under a concurrent on-sale stampede — no double-sell, no double-charge,
zero 5xx, idempotent retries, per-user limits enforced under concurrency.

See `ARCHITECTURE.md` for the full design and the reasoning behind every
correctness mechanism, and `WRITEUP.md` for the required write-up
(atomic decision, idempotency, holds, consistency/availability,
observability, AI usage, next steps).

## Stack

TypeScript + Fastify + raw `pg` (no ORM — see ARCHITECTURE.md for why).
Postgres is the only datastore; no Redis in the critical path.

## Running locally

```bash
cp .env.example .env   # edit secrets if you want, defaults work for local dev
docker-compose up --build
```

This starts Postgres, a local PgBouncer (dev parity with the pooling
behavior production uses via Neon), and the app on `http://localhost:2000`.

Apply the schema once (first run only):

```bash
docker-compose run --rm app node dist/src/db/migrate.js
```

## Running without Docker (what this repo was actually developed/tested against)

```bash
npm install
npm run db:migrate     # requires a local Postgres reachable via DATABASE_URL
npm run build
npm run start
```

## API

All money values are integer paise, never floats.

- `POST /shows` — admin only, header `x-admin-key: <ADMIN_KEY>`
- `GET /shows/:id` — public, no auth
- `POST /shows/:id/reserve` — header `Authorization: Bearer <token>`
- `POST /reservations/:id/cancel` — header `Authorization: Bearer <token>`, owner only
- `GET /healthz` — liveness
- `GET /readyz` — readiness (checks DB)
- `GET /metrics` — Prometheus metrics

There's no signup/login flow in scope for this exercise. Generate a test
token with:

```bash
npm run token -- <userId>
```

It prints a bearer token signed with `AUTH_TOKEN_SECRET` (must match
whatever server you're testing against).

## Running the burst script

The one-command reproduction of the on-sale stampede, including a
hot-seat storm:

```bash
npm run burst -- <BASE_URL> [totalRequests] [hotSeatRequests]
# e.g. against a local server:
npm run burst -- http://localhost:2000 2000 500
```

Requires `ADMIN_KEY` and `AUTH_TOKEN_SECRET` in the environment, matching
the server being targeted. Prints the outcome distribution (confirmed /
declined-by-reason / 5xx) and the final reconciliation check.

## Deployment

Render (app, Docker) + Neon (Postgres, pooled connection string) — see
`SETUP-render-neon.md` for the full checklist. Live URL: _TODO once deployed_.

## Project layout

Routes → Controllers → Actions → DB, deliberately plain (no MVC
framework/ORM — see project history/ARCHITECTURE.md for why):

```
src/
  routes/        — Fastify route registration, thin
  controllers/    — maps request → action call → HTTP response
  actions/        — business logic; this is where the atomic SQL lives
  db/             — pg Pool, transaction helper, schema.sql, migration runner
  middlewares/    — auth (user + admin), structured request logging
  errors/         — domain error hierarchy + the one place errors map to HTTP status
  metrics/        — prom-client setup
  types/
scripts/
  make-token.ts   — generate a test bearer token
  burst.ts        — the one-command burst/stampede script
```
