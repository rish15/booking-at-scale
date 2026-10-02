# Setup checklist — Render (app) + Neon (Postgres)

## 1. Accounts
- [ ] GitHub account with a **public** repo (deliverable #1 requires full commit history, public)
- [ ] Render account (sign up free, connect GitHub)
- [ ] Neon account (sign up free)

## 2. Neon (database)
- [ ] Create a Neon project — pick a region close to where the Render app will deploy (e.g. both US East). Mismatched regions add latency to every single DB round trip, which eats into the timeout budget under the burst.
- [ ] Create the database (default name is fine, e.g. `seats`)
- [ ] Grab the **pooled** connection string (hostname has a `-pooler` suffix) — this is what the app uses. Neon's pooler is PgBouncer under the hood, consistent with the architecture doc.
- [ ] Also grab the **direct/unpooled** connection string — use this only for running the schema migration (some migration tools assume session-level behavior; app runtime always uses the pooled one)
- [ ] Confirm `sslmode=require` is in the connection string (Neon requires TLS)
- [ ] Run the schema migration against Neon (via `psql <direct_url> -f schema.sql` or a small migration script) — includes the `seats`, `shows`, `reservations`, `reservation_seats` tables and the partial index from the architecture doc
- [ ] Know the free-tier behavior going in: autosuspend after 5 min idle, auto-resumes on the next query (no manual action needed) — but the first query after a suspend will be slow. **Hit the DB once to warm it before running the real burst**, so cold-start latency doesn't get conflated with actual performance.

## 3. Render (app)
- [ ] New Web Service → connect the GitHub repo
- [ ] Environment: **Docker** (builds directly from the repo's `Dockerfile`)
- [ ] Region: same as Neon's
- [ ] Instance type: Free
- [ ] Environment variables to set in the Render dashboard (never commit these to git):
  - `DATABASE_URL` — Neon's pooled connection string
  - `NODE_ENV=production`
  - `PER_USER_LIMIT` (default seat limit, e.g. 4)
  - `HOLD_EXPIRY_SECONDS` (e.g. 60)
  - Whatever token/secret the auth middleware uses to verify bearer tokens
- [ ] **App must bind to `process.env.PORT`**, not a hardcoded port — Render injects this at runtime and expects the app to listen on it
- [ ] Set Render's own health check path to `/healthz` (liveness), not `/readyz` — `/readyz` hits the DB, and a transient DB blip would make Render flap/restart the instance unnecessarily. `/readyz` stays for the grader's own checks, not Render's platform health check.
- [ ] Know the free-tier behavior: sleeps after 15 min idle, 30-60s cold start on next request. The assignment explicitly expects this ("must survive a cold start and come up healthy") — not something to hide, just something to account for when timing the burst script.

## 4. Code / Docker changes this implies
- [ ] `Dockerfile` builds and runs cleanly from a fresh clone with no manual steps (test with `docker build` + `docker run` locally before pushing)
- [ ] `docker-compose.yml` keeps a local PgBouncer container for dev parity, but **production doesn't run its own PgBouncer** — Neon provides it. The app's DB client just points at a different connection string per environment (local compose PgBouncer URL vs Neon pooled URL) via `DATABASE_URL`.
- [ ] pg client config: `statement_timeout` and a connection/query timeout set explicitly (per the architecture doc's timeout-handling requirement)
- [ ] Avoid named/cached prepared statements (some ORMs do this for performance — e.g. certain Prisma configurations). Plain `pg` library parameterized queries use unnamed statements by default, which are safe under PgBouncer transaction pooling — but **verify this specifically against Neon's own pooling docs** before relying on it, since hosted poolers sometimes need a connection-string flag for certain clients.
- [ ] `.env.example` committed (documents required env vars, no real secrets) so the README's "clean checkout" instructions are self-contained
- [ ] `.env` itself gitignored

## 5. Pre-flight checks before submitting
- [ ] Fresh `git clone` into a clean directory → `docker-compose up` → confirm it runs end to end locally
- [ ] Hit the live Render URL's `/healthz` and `/readyz` manually once deployed
- [ ] Run a small-scale version of the burst script against the live URL first (not the full 20K) to confirm nothing errors before committing to the full run
- [ ] Warm the Neon DB (one request) and warm the Render instance (one request, waiting out any cold start) immediately before the real burst run, so the measured results reflect steady-state behavior, not cold-start noise
- [ ] Reconcile `available + held + confirmed == total_seats` via `GET /shows/:id` after the burst

## 6. Logs access for the grader
Render's free tier logs are only visible in your own dashboard — no public sharing on the free plan. The assignment explicitly allows for this: **plan to record a short screen capture of the live logs during the burst run** as the fallback it names, rather than assuming public log access exists.

## 7. Secrets hygiene
- [ ] Never commit `DATABASE_URL` or any token/secret to the repo
- [ ] If a real credential ever gets pasted into a chat, file, or commit by mistake, rotate it in Neon's dashboard immediately
