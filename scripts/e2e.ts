// End-to-end verification — runs every behavior the spec cares about
// against a live server and prints a PASS/FAIL report.
//
// Usage:
//   npm run e2e -- [BASE_URL]            (default http://localhost:2000)
//
// Reads ADMIN_KEY and AUTH_TOKEN_SECRET from .env (same as burst.ts), so
// they must match the server being tested. Exits non-zero on any failure.

import "dotenv/config";
import { signToken } from "../src/middlewares/auth";

const BASE_URL = process.argv[2] || "http://localhost:2000";
const ADMIN_KEY = process.env.ADMIN_KEY;

if (!ADMIN_KEY || !process.env.AUTH_TOKEN_SECRET) {
  console.error("ADMIN_KEY and AUTH_TOKEN_SECRET must be set (.env or environment)");
  process.exit(1);
}

// ---------- tiny test harness ----------

interface Result {
  section: string;
  name: string;
  ok: boolean;
  detail: string;
}
const results: Result[] = [];
let section = "";

function startSection(title: string, what: string) {
  section = title;
  console.log(`\n== ${title}\n   ${what}`);
}

function check(name: string, ok: boolean, detail = "") {
  results.push({ section, name, ok, detail });
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n         -> ${detail}`}`);
}

// ---------- http helpers ----------

interface Res {
  status: number;
  body: any;
}

async function call(
  method: string,
  path: string,
  opts: { token?: string; admin?: boolean; body?: unknown } = {}
): Promise<Res> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.admin) headers["x-admin-key"] = ADMIN_KEY!;
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON body (e.g. /metrics) stays as text */
    }
    return { status: res.status, body };
  } catch (err) {
    return { status: 0, body: String(err) };
  }
}

const is2xx = (n: number) => n >= 200 && n < 300;
const tok = (userId: string) => signToken(userId);

async function newShow(seatCount: number, perUserLimit = 4, price = 50000) {
  const seats = Array.from({ length: seatCount }, (_, i) => `A${i + 1}`);
  const res = await call("POST", "/shows", {
    admin: true,
    body: { name: `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, seats, price_paise: price, per_user_limit: perUserLimit },
  });
  if (res.status >= 300) throw new Error(`show creation failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}

const reserve = (showId: string, user: string, seats: string[], key: string, extra: object = {}) =>
  call("POST", `/shows/${showId}/reserve`, { token: tok(user), body: { seats, idempotency_key: key, ...extra } });

async function seatStatus(showId: string, code: string): Promise<string> {
  const res = await call("GET", `/shows/${showId}`);
  return res.body.seats.find((s: any) => s.seat_code === code)?.status ?? "missing";
}

const tally = (rs: Res[]) => {
  const t: Record<string, number> = {};
  for (const r of rs) {
    const k = r.status === 409 ? `409:${r.body?.reason}` : String(r.status);
    t[k] = (t[k] || 0) + 1;
  }
  return t;
};
const fmt = (t: Record<string, number>) => Object.entries(t).map(([k, v]) => `${k}=${v}`).join(" ");

// ---------- scenarios ----------

async function main() {
  console.log(`Target: ${BASE_URL}`);

  startSection("1. Health & metrics", "liveness, readiness (DB), prometheus endpoint");
  check("GET /healthz -> 200", (await call("GET", "/healthz")).status === 200);
  check("GET /readyz -> 200", (await call("GET", "/readyz")).status === 200);
  const m = await call("GET", "/metrics");
  check("GET /metrics exposes reservations_confirmed_total", m.status === 200 && String(m.body).includes("reservations_confirmed_total"));

  startSection("2. Auth", "admin key guards POST /shows; bearer token guards reserve/cancel; GET show is public");
  const bad = await call("POST", "/shows", { body: { name: "x", seats: ["A1"], price_paise: 1 } });
  check("POST /shows without admin key -> 403", bad.status === 403, `got ${bad.status}`);
  const showA = await newShow(10);
  check("POST /shows with admin key creates a show", typeof showA === "string");
  const noTok = await call("POST", `/shows/${showA}/reserve`, { body: { seats: ["A1"], idempotency_key: "k" } });
  check("reserve without token -> 401", noTok.status === 401, `got ${noTok.status}`);
  const badTok = await call("POST", `/shows/${showA}/reserve`, { token: "user1.deadbeef", body: { seats: ["A1"], idempotency_key: "k" } });
  check("reserve with forged token -> 401", badTok.status === 401, `got ${badTok.status}`);
  check("GET /shows/:id needs no auth -> 200", (await call("GET", `/shows/${showA}`)).status === 200);

  startSection("3. Validation", "bad input is a 4xx, never a 5xx");
  check("empty seats -> 400", (await reserve(showA, "u-val", [], "v1")).status === 400);
  check("duplicate seats -> 400", (await reserve(showA, "u-val", ["A1", "A1"], "v2")).status === 400);
  const noKey = await call("POST", `/shows/${showA}/reserve`, { token: tok("u-val"), body: { seats: ["A1"] } });
  check("missing idempotency_key -> 400", noKey.status === 400);
  check("unknown show -> 404", (await reserve("00000000-0000-0000-0000-000000000000", "u-val", ["A1"], "v3")).status === 404);
  const unk = await reserve(showA, "u-val", ["ZZ99"], "v4");
  check("unknown seat code -> 4xx (not 5xx)", unk.status >= 400 && unk.status < 500, `got ${unk.status}`);

  startSection("4. Happy path + idempotency", "reserve, replay same key, reordered seats, key reuse with different request");
  const r1 = await reserve(showA, "user1", ["A1"], "req-1");
  check("reserve A1 -> 201 confirmed, amount = price", r1.status === 201 && r1.body.status === "confirmed" && r1.body.amount_paise === 50000, JSON.stringify(r1.body));
  const r1b = await reserve(showA, "user1", ["A1"], "req-1");
  check("replay same key -> same reservation_id", is2xx(r1b.status) && r1b.body.reservation_id === r1.body.reservation_id, JSON.stringify(r1b.body));
  const r1c = await reserve(showA, "user1", ["A2"], "req-1");
  check("same key, different seats -> 409 idempotent_conflict", r1c.status === 409 && r1c.body.reason === "idempotent_conflict", JSON.stringify(r1c.body));
  const r2 = await reserve(showA, "user1", ["A3", "A2"], "req-2");
  const r2b = await reserve(showA, "user1", ["A2", "A3"], "req-2");
  check("reordered seats on retry still recognized as same request", is2xx(r2.status) && is2xx(r2b.status) && r2.body.reservation_id === r2b.body.reservation_id, JSON.stringify(r2b.body));
  check("another user can reuse the same key string independently", is2xx((await reserve(showA, "user9", ["A10"], "req-1")).status));

  startSection("5. Conflicts & atomicity", "seat taken; multi-seat request is all-or-nothing; identity comes from token");
  const taken = await reserve(showA, "user2", ["A1"], "t-1");
  check("other user, taken seat -> 409 seat_taken", taken.status === 409 && taken.body.reason === "seat_taken", JSON.stringify(taken.body));
  const partial = await reserve(showA, "user2", ["A9", "A1"], "t-2");
  check("[free, taken] request -> 409", partial.status === 409);
  check("...and the free seat (A9) was NOT left held (rollback)", (await seatStatus(showA, "A9")) === "available");
  const spoof = await reserve(showA, "user3", ["A8"], "t-3", { user_id: "user1" });
  check("body user_id is ignored (reservation belongs to token user)", is2xx(spoof.status) && spoof.body.user_id === "user3", JSON.stringify(spoof.body));

  startSection("6. Per-user limit", "limit is 4; user1 already holds A1,A2,A3 (3 seats)");
  const over = await reserve(showA, "user1", ["A4", "A5"], "lim-1");
  check("asking for 2 more (total 5) -> 409 per_user_limit", over.status === 409 && over.body.reason === "per_user_limit", JSON.stringify(over.body));
  check("...and neither seat was taken", (await seatStatus(showA, "A4")) === "available" && (await seatStatus(showA, "A5")) === "available");
  check("asking for 1 more (total 4) is allowed", is2xx((await reserve(showA, "user1", ["A4"], "lim-2")).status));

  startSection("7. Cancel", "owner-only, idempotent, frees the seat");
  const c1 = await call("POST", `/reservations/${r1.body.reservation_id}/cancel`, { token: tok("user2") });
  check("non-owner cancel -> 403", c1.status === 403, `got ${c1.status}`);
  const c2 = await call("POST", `/reservations/${r1.body.reservation_id}/cancel`, { token: tok("user1") });
  check("owner cancel -> 200 cancelled", c2.status === 200 && c2.body.status === "cancelled", JSON.stringify(c2.body));
  check("repeat cancel is a harmless no-op -> 200", (await call("POST", `/reservations/${r1.body.reservation_id}/cancel`, { token: tok("user1") })).status === 200);
  check("cancelled seat A1 is available again", (await seatStatus(showA, "A1")) === "available");
  check("someone else can now reserve A1", is2xx((await reserve(showA, "user2", ["A1"], "t-4")).status));
  check("cancel of unknown reservation -> 404", (await call("POST", "/reservations/00000000-0000-0000-0000-000000000000/cancel", { token: tok("user1") })).status === 404);

  startSection("8. Concurrency: one hot seat", "100 different users race for the same seat at once");
  const showB = await newShow(5);
  const hot = await Promise.all(Array.from({ length: 100 }, (_, i) => reserve(showB, `racer${i}`, ["A1"], `hot-${i}`)));
  const ht = tally(hot);
  check(`exactly 1 winner (${fmt(ht)})`, ht["201"] === 1 && ht["409:seat_taken"] === 99);
  check("zero 5xx", hot.every((r) => r.status < 500));
  check("seat is confirmed exactly once", (await seatStatus(showB, "A1")) === "confirmed");

  startSection("9. Concurrency: per-user limit", "one user fires 12 parallel requests for 12 different seats; limit is 4");
  const showC = await newShow(20);
  const lim = await Promise.all(Array.from({ length: 12 }, (_, i) => reserve(showC, "greedy", [`A${i + 1}`], `g-${i}`)));
  const lt = tally(lim);
  check(`exactly 4 confirmed (${fmt(lt)})`, lt["201"] === 4 && lt["409:per_user_limit"] === 8);
  check("zero 5xx", lim.every((r) => r.status < 500));
  const stC = await call("GET", `/shows/${showC}`);
  check("only 4 seats actually confirmed in DB", stC.body.counts.confirmed === 4, JSON.stringify(stC.body.counts));

  startSection("10. Concurrency: idempotent retry storm", "same user + same key sent 30 times in parallel");
  const showD = await newShow(5);
  const storm = await Promise.all(Array.from({ length: 30 }, () => reserve(showD, "retrier", ["A1"], "same-key")));
  const ids = new Set(storm.filter((r) => is2xx(r.status)).map((r) => r.body.reservation_id));
  check(`all successful responses share one reservation_id (${ids.size} distinct)`, ids.size === 1);
  check("zero 5xx", storm.every((r) => r.status < 500), fmt(tally(storm)));
  const stD = await call("GET", `/shows/${showD}`);
  check("exactly 1 seat confirmed (reserved once, not 30 times)", stD.body.counts.confirmed === 1, JSON.stringify(stD.body.counts));

  startSection("11. Reconciliation", "available + held + confirmed == total for every show created above");
  for (const [label, id] of [["A", showA], ["B", showB], ["C", showC], ["D", showD]] as const) {
    const s = await call("GET", `/shows/${id}`);
    const c = s.body.counts;
    check(`show ${label}: ${c.available}+${c.held}+${c.confirmed} == ${c.total}`, c.available + c.held + c.confirmed === c.total);
  }

  // ---------- report ----------
  const failed = results.filter((r) => !r.ok);
  console.log("\n==================== REPORT ====================");
  const sections = [...new Set(results.map((r) => r.section))];
  for (const s of sections) {
    const rs = results.filter((r) => r.section === s);
    const p = rs.filter((r) => r.ok).length;
    console.log(`${p === rs.length ? "PASS" : "FAIL"}  ${s}  (${p}/${rs.length})`);
  }
  console.log(`\nTotal: ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`  - [${f.section}] ${f.name}${f.detail ? `\n      ${f.detail}` : ""}`);
    process.exit(1);
  }
  console.log("ALL CHECKS PASSED");
}

main().catch((err) => {
  console.error("e2e aborted:", err);
  process.exit(1);
});
