# Architecture — Seat Reservation at Scale

> **Note on hold/expiry (added during implementation):** this document
> works through a full auto-expiring-hold design (see Fix 3 below) before
> implementation surfaced that the spec's own example response returns
> `"status": "confirmed"` synchronously from `reserve`, with no separate
> payment/confirm step anywhere in the functional requirements. Given
> that, the implementation ships the simpler of the two models the spec
> explicitly offers — **explicit cancel, no auto-expiring hold** — seats
> go directly `available → confirmed`. The Fix 3 mechanism below is sound
> and still the right one to reach for if a future version needs a real
> "hold while payment processes" step; it just isn't what got built. Full
> reasoning in `WRITEUP.md` under "Holds & expiry".

## Design philosophy

The correctness bar (no double-sell, zero 5xx, idempotent retries, per-user limits, reconciliation invariant) is graded by hammering the **live system** with concurrency — not by reading code. So the architecture is built around one rule: **the atomic decision for "who gets this seat" lives in exactly one place, enforced by the datastore itself, not by application logic.**

That has a direct consequence for the Redis question: **Postgres alone is sufficient and is the safer choice for correctness.** A conditional `UPDATE ... WHERE status='available'` and a `UNIQUE` constraint are atomic by construction — there's no race window to reason about. Introducing Redis as a second source of truth adds a second place where consistency can drift between Redis and Postgres under exactly the failure conditions this exercise is designed to expose. Two systems of record is strictly worse than one for this problem.

**Where Redis does earn its place: as a non-authoritative accelerator, never as a decision-maker.**
- Caching `GET /shows/{id}` reads (hot path under the burst) — short TTL, always safe to fall through to Postgres, never the source of truth.
- Optionally, a coarse edge-level rate limiter in front of the API — nice-to-have, not required, and adds a deploy dependency that's one more thing that can be down during grading. Cut from v1.

**Decision: Postgres only for v1.** No Redis in the critical path.

A harder-won lesson from two rounds of review on this document: **"inside one transaction" is not automatically "atomic," and "atomic" is not automatically "won't silently desync."** The first draft had a per-user limit check that looked safe but had a phantom-read race. The fix for that (a denormalized counter table) was itself a new bug — correct under concurrency, but wrong under the ordinary cancel/expiry flow, because nothing kept the counter in sync with reality. The design below replaces that counter with a value derived live from the single source of truth, specifically to avoid needing a second place that can drift.

---

## High-level diagram

```
                              ┌─────────────────────────┐
                              │   Burst script /         │
                              │   grader's load test      │
                              └───────────┬──────────────┘
                                          │ HTTPS
                                          ▼
                              ┌─────────────────────────┐
                              │   Node.js API (Fastify)  │
                              │                          │
                              │  ┌────────────────────┐  │
                              │  │ Auth middleware     │  │  stateless token → user_id
                              │  │ (no DB round trip)  │  │  (ignores body)
                              │  └─────────┬──────────┘  │
                              │            ▼              │
                              │  ┌────────────────────┐  │
                              │  │ Request handlers    │  │
                              │  │ /shows               │  │
                              │  │ /shows/:id/reserve   │  │
                              │  │ /reservations/:id/   │  │
                              │  │   cancel (idempotent)│  │
                              │  │ /shows/:id (GET)     │  │
                              │  └─────────┬──────────┘  │
                              │            ▼              │
                              │  ┌────────────────────┐  │
                              │  │ /healthz /readyz    │  │  readyz uses a
                              │  │ /metrics (Prometheus)│  │  dedicated connection,
                              │  └────────────────────┘  │  not the main pool
                              │                          │
                              │  ┌────────────────────┐  │
                              │  │ Hold-expiry cron     │  │  housekeeping only —
                              │  └────────────────────┘  │  not in correctness path
                              └───────────┬──────────────┘
                                          │ small bounded pool (10-20 conns)
                                          │ driver: prepared statements OFF
                                          ▼
                              ┌─────────────────────────┐
                              │   PgBouncer                │  transaction-pooling mode —
                              │   (or platform equivalent) │  absorbs 20K concurrent
                              └───────────┬──────────────┘  HTTP requests down to a
                                          ▼                  sane number of DB conns
                              ┌─────────────────────────┐
                              │   PostgreSQL               │
                              │   (system of record)       │
                              │                            │
                              │  shows                     │
                              │  seats           ← conditional UPDATE, double-sell guard,
                              │                    held_by column is the only source of
                              │                    truth for "who holds what"
                              │  reservations    ← UNIQUE(show_id, user_id, idempotency_key)
                              │  reservation_seats          │
                              └─────────────────────────┘

                              ┌─────────────────────────┐
                              │  Structured logs           │  → stdout, JSON, request-id
                              │  (pino)                     │     tagged → platform log viewer
                              └─────────────────────────┘
```

One stateless API process, a connection pooler in front of Postgres, one Postgres instance. No Redis, no queue, no separate microservices, and — per the fix below — no denormalized counter table either.

---

## Components

### 1. API process (Node.js + Fastify)
Stateless HTTP JSON API, horizontally scalable (all correctness-critical state lives in Postgres). Fastify for lower overhead under burst load and schema validation that rejects malformed requests before they touch the DB.

### 2. Auth middleware
Resolves `user_id` from a **stateless** token (signed/HMAC, verified in-process — not a DB lookup). This matters under 20K concurrent requests: a DB-backed auth lookup would double the number of DB round trips per request and compound the connection-pool pressure described below. Any `user_id`-shaped field in the request body is ignored entirely — identity resolution never reads from the body.

### 3. Request handlers
- `POST /shows` — admin creates a show; seeds `seats` rows, all `available`.
- `POST /shows/:id/reserve` — see request flow below.
- `POST /reservations/:id/cancel` — owner-only; releases held/confirmed seats via the same conditional-update pattern as reserve (not read-then-write), and sets `reservations.status='cancelled'` in the same transaction so a later lookup by reservation id reflects it. `reservation_seats` rows are kept as a historical record rather than deleted — doesn't affect correctness either way, just useful for audit/debugging. **Idempotent by design**: cancelling an already-cancelled or already-released reservation finds 0 matching rows in the conditional UPDATE and returns success (no-op), never an error — a client retry of a cancel call must not surface as a failure.
- `GET /shows/:id` — per-seat status + counts; also the reconciliation check endpoint.

### 4. Postgres schema (system of record)
```sql
shows(id, name, price_paise, per_user_limit, created_at)

seats(
  show_id, seat_code, status, held_by, expires_at,
  PRIMARY KEY (show_id, seat_code)
)  -- status ∈ {available, held, confirmed}
   -- held_by is the single source of truth for "who holds what" —
   -- nothing else derives or caches this value

reservations(
  id, show_id, user_id, idempotency_key, request_hash,
  status, amount_paise, created_at,
  UNIQUE (show_id, user_id, idempotency_key)   -- scoped to user_id, so two
)                                               -- different users can never
                                                -- collide on the same key string

reservation_seats(reservation_id, seat_code)

-- Supports the Fix 2 per-user-limit COUNT below. Without this, that query is a
-- sequential scan over every seat in the show on every single reserve call —
-- under a 20K-concurrent burst this is a direct threat to request latency,
-- which is what the whole statement_timeout/connection-pool design assumes stays low.
CREATE INDEX idx_seats_user_holds ON seats (show_id, held_by)
  WHERE status IN ('held', 'confirmed');
```

No `user_show_holds` counter table. An earlier draft added one to make the per-user-limit check atomic, but a counter that's incremented on reserve and never decremented on cancel or expiry drifts upward forever — users get wrongly capped after enough cancels/expiries, which is a guaranteed bug on the normal path, not a rare race. Replaced with an advisory lock (Fix 2 below), so the limit is always checked against the live state of `seats`, which can never desync from itself.

**Fix 1 — idempotency key scoped per user.** `UNIQUE(show_id, idempotency_key)` without `user_id` let two different users' clients collide on the same key string (coincidental or adversarial), letting one user's retry resolve against another user's reservation. Scoping to `(show_id, user_id, idempotency_key)` makes cross-user collision impossible while still catching true retries from the same user.

**Fix 2 — per-user limit via a transaction-scoped advisory lock + live COUNT, not a counter table.**
```sql
-- first statement in the reserve transaction:
SELECT pg_advisory_xact_lock(hashtext($show_id || ':' || $user_id));

-- now safe — only THIS user's own concurrent reserve attempts serialize here,
-- other users are never blocked by this lock:
SELECT COUNT(*) FROM seats
WHERE show_id = $show_id AND held_by = $user_id AND status IN ('held','confirmed');
```
If `count + requested_seats > per_user_limit`, decline with 409 before touching any seat row. This must be `pg_advisory_XACT_lock` (transaction-scoped, released automatically at commit/rollback), **not** `pg_advisory_lock` (session-scoped) — see the PgBouncer note below for why the distinction matters. Because the limit is now read live from `seats` itself, cancel and expiry need zero special-case bookkeeping to keep it correct — there's nothing to keep in sync.

**Fix 3 — hold expiry folded into the acquisition query, not left to the cron.**
```sql
UPDATE seats SET status='held', held_by=$user, expires_at=now()+interval 'N seconds'
WHERE show_id=$id AND seat_code=$seat
  AND (status='available' OR (status='held' AND expires_at < now()))
RETURNING *;
```
This removes the dependency on cron timing for correctness — an expired hold is immediately re-bookable by the very next request, not just after the next cron tick. The cron becomes pure housekeeping (flips stale rows back to `available` for clean `GET /shows/:id` reporting), never part of the decision path.

### 5. Hold-expiry cron
Runs every few seconds: `UPDATE seats SET status='available' WHERE status='held' AND expires_at < now()`. Purely cosmetic/cleanup now that Fix 3 makes the reserve path itself expiry-aware — safe to run on a single instance, safe to skip a tick, safe to run redundantly. Requires no interaction with the per-user limit (Fix 2 derives that live, so an expired seat is simply absent from the next `COUNT`).

### 6. Connection capacity under a 20K-concurrent burst
Called out as its own component, not an afterthought, since this is the most likely reason a *correct* design still fails the live grading run:
- **Bounded app-side pool** (e.g. 10-20 connections), never "as many as concurrent requests."
- **PgBouncer in transaction-pooling mode** in front of Postgres, so 20,000 concurrent HTTP requests multiplex down to a small, sane number of real DB connections. Free-tier Postgres on Render/Railway caps connections low (often double digits) — this makes the pooler non-optional.
- **Two concrete PgBouncer gotchas this design must account for, not just the pooler itself:**
  - **Prepared statements** (default behavior in most Postgres drivers, including node-postgres) are unsafe under transaction-pooling mode, because a prepared statement is session-scoped but the underlying connection can be handed to a different client between calls. Must be explicitly disabled in the driver config (or the pooler configured to tolerate it) — otherwise expect sporadic, hard-to-reproduce errors precisely during the concurrent burst being graded.
  - **Session-scoped locks break the same way.** This is why Fix 2 specifically uses `pg_advisory_xact_lock` (transaction-scoped, auto-released at commit/rollback) and never `pg_advisory_lock` (session-scoped) — the latter's lock/connection pinning assumption doesn't hold under transaction pooling.
- **`statement_timeout` and `lock_timeout`** set at the connection level — but setting them is only half the fix. The app must **explicitly catch the Postgres error codes they raise** (`57014 query_canceled` for statement_timeout, `55P03 lock_not_available` for lock_timeout) and map them to a 409/429 response. Left uncaught, they surface as unhandled driver exceptions — i.e. exactly the 500 this design exists to prevent. "Zero 5xx" is a statement about error-handling code, not just a config value.
- **`lock_timeout` also bounds `pg_advisory_xact_lock`, and this is what protects pool fairness, not just per-request latency.** If one user's client fires many concurrent requests with distinct idempotency keys, all of them serialize on that user's advisory lock, each occupying a pooled connection while it waits. `lock_timeout` is what caps how long any single user's pile-up can tie up shared pool capacity during a burst — worth setting with "protects other users' requests" in mind, not just "reasonable latency for this one request."
- **Every transaction must be explicitly closed on every code path, not just the designed-for ones.** Under transaction-pooling mode, a connection only returns to PgBouncer's pool once its transaction is cleanly committed or rolled back. A handler that throws an unexpected exception mid-transaction (not just the planned decline paths) and doesn't explicitly `ROLLBACK` leaves that transaction open — repeated under a 20K-request burst, this quietly starves the already-small bounded pool, which is the same failure mode as the connection-exhaustion risk above, just triggered by an error-handling gap instead of raw volume. Every reserve/cancel code path needs try/catch/finally (or the driver's managed transaction helper) guaranteeing rollback on any thrown error.
- **`/readyz` uses a separate, dedicated connection** (or a very short timeout) rather than competing with live request traffic for the same pool — otherwise it can falsely report "not ready" at the exact moment the pool is busiest, or steal a slot a real request needed.

### 7. Observability
- `/healthz` — liveness, 200 if the process is up.
- `/readyz` — readiness, real `SELECT 1` against Postgres via a dedicated connection; 503 if unreachable (fails closed).
- `/metrics` — `prom-client`: `reservations_confirmed_total` (counter), `reservations_declined_total{reason}` (labeled seat_taken / per_user_limit / idempotent_replay), `seats_available` (gauge, per show).
- Structured JSON logs via `pino`, every request tagged with a correlation/request ID.

### 8. Deployment
Dockerfile + `docker-compose.yml` (API + Postgres + PgBouncer) for local/clean-checkout parity. Deployed to Railway or Render — managed Postgres add-on, pooler in front of it (transaction-pooling mode, prepared statements disabled in the driver), app container built from the same Dockerfile used locally.

---

## Request flow: `POST /shows/:id/reserve` (the critical path)

1. Auth middleware resolves `user_id` from the stateless token — no DB hit.
2. Validate body shape (seats array, idempotency_key required).
3. **Idempotency check** (single statement, scoped per user):
   - `INSERT INTO reservations (show_id, user_id, idempotency_key, request_hash, status='pending') ON CONFLICT (show_id, user_id, idempotency_key) DO NOTHING RETURNING *`
   - `request_hash` is computed over the **sorted** seats array (order-independent — `["A12","A13"]` and `["A13","A12"]` must hash identically, so a retry with reordered seats is still recognized as the same request).
   - If conflict and no row returned: fetch the existing row by key. Matching hash → return the original reservation (idempotent replay). Mismatched hash → 409.
4. **Per-user limit** (Fix 2): take the advisory xact lock for `(show_id, user_id)`, then `COUNT` the user's current held+confirmed seats directly from `seats`. Over limit → 409, roll back, no seats touched.
5. **Seat acquisition**: for each requested seat, in sorted seat-code order (deadlock avoidance for multi-seat), run the expiry-aware conditional `UPDATE` (Fix 3). All-or-nothing: any seat failing to acquire (0 rows updated) rolls back the whole transaction — caller gets 409 naming which seat(s) were taken.
6. Mark the reservation `confirmed`, insert into `reservation_seats`, commit.
7. Increment Prometheus counters based on outcome; log with correlation ID. Any `statement_timeout`/`lock_timeout` error caught here is mapped to 409/429, never allowed to surface as a 500.

Every statement in steps 3-6 is individually atomic (conditional UPDATE, advisory lock + COUNT, INSERT ON CONFLICT) — the surrounding transaction guarantees all-or-nothing rollback, not the correctness itself. Correctness doesn't depend on isolation level or lock duration, only on each statement's own atomicity and on every piece of "who holds what" state living in exactly one place (`seats.held_by`).

---

## What's deliberately left out of v1 (documented in WRITEUP.md, not hidden)
- Redis caching layer for `GET /shows/{id}` reads — add if time permits post-core.
- Real payment integration — out of scope per the spec.
- Multi-instance horizontal scaling validation — architecture supports it (stateless API + pooled single Postgres as sole coordination point), but only a single instance will be deployed/tested given the time budget.
