# Write-up

## The atomic decision

No seat decision is ever a read-then-write. Every seat acquisition is a
single conditional `UPDATE`:

```sql
UPDATE seats
SET status = 'confirmed', held_by = $1
WHERE show_id = $2 AND seat_code = $3 AND status = 'available'
RETURNING seat_code;
```

This is atomic by construction — Postgres evaluates the `WHERE` clause and
applies the write as one indivisible operation. Under concurrent requests
for the same seat, exactly one `UPDATE` affects a row (`RETURNING` returns
it); every other concurrent attempt sees `rowCount === 0` and is declined
with 409 `seat_taken`. There is no window between "check if available" and
"mark as taken" for two requests to interleave, because there is no
separate check — the condition and the write are the same statement.

For multi-seat requests, seats are acquired **in sorted seat-code order**
(`[...seats].sort()`), inside a single transaction, all-or-nothing: the
first seat that fails to acquire throws immediately and the transaction
rolls back everything acquired so far. Locking in a consistent order
across every request is what prevents deadlock — two requests that both
want seats `A1` and `A2` will always both attempt `A1` before `A2`, so
neither can be stuck holding `A1` while waiting for `A2` that the other
holds and vice versa.

The per-user limit is the other place correctness depends on atomicity,
and it took two iterations to get right. A naive `SELECT COUNT(*) FOR
UPDATE` doesn't work — it can't lock rows that don't exist yet, so two
concurrent first-time requests from a user holding zero seats can both read
count=0 before either commits. The actual mechanism is a **transaction-scoped
advisory lock**, keyed per `(show_id, user_id)`:

```sql
SELECT pg_advisory_xact_lock(hashtext($1)); -- '<show_id>:<user_id>'
SELECT COUNT(*) FROM seats WHERE show_id = $1 AND held_by = $2 AND status IN ('held','confirmed');
```

This serializes a given user's own concurrent reserve attempts against
each other — and *only* their own; two different users never contend on
this lock. Because the limit is read live off `seats` (the single source
of truth for "who holds what"), cancel never needs separate bookkeeping to
keep a counter in sync — there's nothing to desync in the first place. (An
earlier design used a denormalized counter table instead; it was dropped
specifically because nothing decremented it on cancel, so it silently
drifted upward on the normal path, not just under a race.)

## Idempotency

The idempotency key is stored as a column on `reservations`, under
`UNIQUE (show_id, user_id, idempotency_key)` — scoped to the user, not just
the show, so two different users can never collide on the same key string
even if their clients coincidentally (or adversarially) pick the same one.

Exactly-once is enforced the same way seat acquisition is — one atomic
statement, not check-then-insert:

```sql
INSERT INTO reservations (show_id, user_id, idempotency_key, request_hash, status)
VALUES ($1, $2, $3, $4, 'pending')
ON CONFLICT (show_id, user_id, idempotency_key) DO NOTHING
RETURNING id;
```

If this returns 0 rows, the key has been used before. The stored
`request_hash` (SHA-256 over the **sorted** seats array — so `["A12","A13"]`
and `["A13","A12"]` hash identically, and a client retry with reordered
seats is still recognized as the same request) is compared against a hash
of the current request:

- Same hash → this is a genuine retry. Return the original reservation's
  outcome without touching any seat again.
- Different hash → the key was reused for a materially different request
  → 409 `idempotent_conflict`.

A subtlety worth naming: a `'pending'` row never persists at rest. If a
request is declined for any reason (seat taken, over limit, timeout), the
whole transaction — including the idempotency insert — rolls back. So any
row a later lookup finds by key is guaranteed to already be in a terminal
`'confirmed'` state, never a stuck `'pending'`.

## Holds & expiry

**Chosen model: explicit cancel, no auto-expiring hold.** The spec offers a
choice here, and the spec's own example response returns `"status":
"confirmed"` synchronously from `reserve` — there's no separate
payment/confirmation step defined anywhere in the functional requirements.
Given that, seats move directly `available → confirmed` in the same
atomic `UPDATE`; there's no reason to introduce a transient `'held'` state
with a timeout for something that confirms immediately. `'held'` remains a
valid value in the `seats.status` column for schema clarity/future
extension, but this implementation's reserve path never writes it.

Release is `POST /reservations/:id/cancel`, owner-only (identity is
token-derived, checked against the reservation's `user_id` before anything
is released — not a client-supplied field). It's idempotent by design:
cancelling an already-cancelled reservation finds 0 matching rows in its
own conditional `UPDATE` and returns success as a no-op, not an error — a
client retry of a cancel call should never surface as a failure.

The earlier design (see ARCHITECTURE.md, written before this trade-off was
resolved) worked through a real auto-expiring-hold model — a conditional
`UPDATE` that also treats an expired hold as available, so correctness
doesn't depend on cron timing. That mechanism is sound and is the right
one to reach for if a future version needs a genuine "hold while payment
processes" step; it just isn't needed for what this exercise's response
contract actually asks for.

## Consistency vs availability under a partition

This service chooses **consistency over availability for the write path,
and availability over consistency for reads.**

If Postgres is unreachable, `reserve` and `cancel` fail outright — there is
no fallback datastore that could accept a seat decision without the risk
of double-selling later. That's the right trade-off here: a seat booking
system's entire value proposition is "no one is ever sold the same seat
twice," so weakening consistency to stay available during a partition
would directly undermine the thing being graded. `/readyz` reflects this
by checking the DB and failing closed — if the DB is down, the service
correctly reports itself as not ready rather than accepting requests it
can't safely fulfill.

`GET /shows/:id` reads are the one place a different trade-off would make
sense at larger scale — a short-TTL cache in front of it (deliberately not
built in v1; see "What's deliberately left out" in ARCHITECTURE.md) would
mean a reader could see slightly stale seat counts during a partition
rather than an outright failure, which is an acceptable trade for a
read-only view that isn't making any booking decision.

## Observability — what would page someone at 2am

- **`reservations_declined_total{reason="seat_taken"}` spiking far beyond
  what traffic volume explains** — could indicate the conditional-UPDATE
  guard is somehow over-triggering (e.g. a bad deploy that broke the
  expiry/availability logic), not just normal contention.
- **`/readyz` failing** — the DB is unreachable; this should page
  immediately since every write request is about to start failing.
- **A nonzero 5xx rate** — given the explicit "zero 5xx" bar this service
  is built around, any 5xx at all is a signal something slipped past the
  timeout→429 translation (see ARCHITECTURE.md §6) and should be treated
  as a correctness regression, not routine noise.
- **The reconciliation invariant failing** (`available + held + confirmed
  != total_seats` from `GET /shows/:id`) — this should never happen given
  how the schema is structured (every seat is in exactly one status
  column value, always), so if it ever does, something has bypassed the
  normal write path entirely (a manual DB edit, a bug in a future
  migration) and needs investigating immediately.

## AI usage

Claude was used throughout — for architecture review (several rounds of
deliberately adversarial review surfaced real bugs before they were coded:
a phantom-read race in an early per-user-limit design, a silent
desync bug in the fix that replaced it, missing index coverage, PgBouncer
prepared-statement/advisory-lock gotchas), for translating an existing
personal Node.js project template's conventions (routes → controllers →
actions → errors) into this stack, and for writing the implementation
itself from the resulting design.

What was directed, not just accepted: the decision to drop Sequelize/any
ORM in favor of raw `pg` (so the exact atomic SQL stays visible and
uneditable-by-abstraction); TypeScript over the template's original
JavaScript; Fastify over Express and over Next.js (ruled out specifically
because its serverless-leaning API routes fight a persistent connection
pool and an in-process cron); Postgres-only over adding Redis (two
sources of truth is worse than one for exactly the failure modes this
exercise tests); and the explicit-cancel-over-auto-expiring-hold call
above, made after noticing the spec's own example response contradicted
the hold-based design that had been built first.

What AI produced directly: the bulk of the line-by-line implementation,
following the design decisions above, plus the review passes that found
the bugs described in "the atomic decision" and "holds & expiry" sections.
Expect to be asked to extend this live — every mechanism in this write-up
(the advisory lock, the idempotency hash, the all-or-nothing multi-seat
transaction) is something that can be walked through and modified on the
spot, not a black box.

## What's next

- Redis-backed short-TTL cache in front of `GET /shows/:id`, now that the
  primary write path doesn't depend on it for correctness.
- Horizontal scaling validation — the architecture is stateless-API +
  single-Postgres-as-coordination-point by design, but only a single
  instance has actually been deployed/load-tested given the time budget.
- A real admin auth scheme in place of the static shared key.
- Structured log shipping to something queryable (currently stdout JSON
  only, readable via the platform's log viewer or a screen capture under
  load).
