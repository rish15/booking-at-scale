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

// Raw request for hostile input (malformed bodies etc.) that call() can't express.
async function raw(method: string, path: string, headers: Record<string, string>, body?: string): Promise<Res> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, { method, headers, body });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* keep text */ }
    return { status: res.status, body: parsed };
  } catch (err) {
    return { status: 0, body: String(err) };
  }
}

// Prometheus text parsing: sum of all samples of `name` whose labels contain every given pair.
async function metricsText(): Promise<string> {
  return String((await call("GET", "/metrics")).body);
}
function mval(text: string, name: string, labels: Record<string, string> = {}): number {
  let sum = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith(name + "{") && !line.startsWith(name + " ")) continue;
    if (!Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`))) continue;
    sum += parseFloat(line.slice(line.lastIndexOf(" ") + 1));
  }
  return sum;
}
function sum5xx(text: string): number {
  let sum = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("http_requests_total{") && /status="5\d\d"/.test(line)) {
      sum += parseFloat(line.slice(line.lastIndexOf(" ") + 1));
    }
  }
  return sum;
}
const trackedShows: [string, string][] = [];

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
  const metricsAtStart = await metricsText();

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


  startSection("11. Malformed & hostile input", "bad IDs, bad JSON, absurd sizes: always a clean 4xx, never a 5xx");
  const jsonH = { "Content-Type": "application/json", Authorization: `Bearer ${tok("hostile")}` };
  const mj = await raw("POST", `/shows/${showA}/reserve`, jsonH, "{not json");
  check("malformed JSON body -> 400", mj.status === 400, `got ${mj.status}`);
  const nobody = await raw("POST", `/shows/${showA}/reserve`, jsonH);
  check("empty body on reserve -> 400", nobody.status === 400, `got ${nobody.status}`);
  const badShowId = await call("GET", "/shows/not-a-uuid");
  check("GET /shows/not-a-uuid -> 4xx", badShowId.status >= 400 && badShowId.status < 500, `got ${badShowId.status}`);
  const badShowRes = await reserve("not-a-uuid", "hostile", ["A1"], "h1");
  check("reserve on /shows/not-a-uuid -> 4xx", badShowRes.status >= 400 && badShowRes.status < 500, `got ${badShowRes.status}`);
  const badCancel = await call("POST", "/reservations/not-a-uuid/cancel", { token: tok("hostile") });
  check("cancel /reservations/not-a-uuid -> 4xx", badCancel.status >= 400 && badCancel.status < 500, `got ${badCancel.status}`);
  const longSeat = await reserve(showA, "hostile", ["X".repeat(10000)], "h2");
  check("10k-char seat code -> 4xx", longSeat.status >= 400 && longSeat.status < 500, `got ${longSeat.status}`);
  const manySeats = await reserve(showA, "hostile", Array.from({ length: 5000 }, (_, i) => `S${i}`), "h3");
  check("5000 seats in one request -> 4xx", manySeats.status >= 400 && manySeats.status < 500, `got ${manySeats.status}`);
  const numKey = await call("POST", `/shows/${showA}/reserve`, { token: tok("hostile"), body: { seats: ["A5"], idempotency_key: 123 } });
  check("non-string idempotency_key -> 400", numKey.status === 400, `got ${numKey.status}`);
  const longKey = await reserve(showA, "hostile", ["A5"], "k".repeat(10000));
  check("10k-char idempotency_key -> 4xx", longKey.status >= 400 && longKey.status < 500, `got ${longKey.status}`);
  const nonStr = await call("POST", `/shows/${showA}/reserve`, { token: tok("hostile"), body: { seats: [1, 2], idempotency_key: "h4" } });
  check("non-string seat entries -> 400", nonStr.status === 400, `got ${nonStr.status}`);
  const five = await reserve(await newShow(10), "hostile", ["A1", "A2", "A3", "A4", "A5"], "h5");
  check("5 seats at once with limit 4 -> 409 per_user_limit", five.status === 409 && five.body.reason === "per_user_limit", JSON.stringify(five.body));
  check("unknown route -> 404", (await call("GET", "/nope")).status === 404);
  const createBad = async (label: string, body: unknown) => {
    const r = await call("POST", "/shows", { admin: true, body });
    check(`create show: ${label} -> 400`, r.status === 400, `got ${r.status}`);
  };
  await createBad("missing name", { seats: ["A1"], price_paise: 100 });
  await createBad("empty seats", { name: "x", seats: [], price_paise: 100 });
  await createBad("duplicate seats", { name: "x", seats: ["A1", "A1"], price_paise: 100 });
  await createBad("negative price", { name: "x", seats: ["A1"], price_paise: -1 });
  await createBad("float price", { name: "x", seats: ["A1"], price_paise: 10.5 });
  await createBad("per_user_limit 0", { name: "x", seats: ["A1"], price_paise: 100, per_user_limit: 0 });
  const mjShow = await raw("POST", "/shows", { "Content-Type": "application/json", "x-admin-key": ADMIN_KEY! }, "{oops");
  check("create show: malformed JSON -> 400", mjShow.status === 400, `got ${mjShow.status}`);

  startSection("12. Idempotency edge cases", "retry after a decline, replay after cancel");
  const showE = await newShow(5);
  trackedShows.push(["E", showE]);
  const holder = await reserve(showE, "holder", ["A1"], "e-1");
  const decl = await reserve(showE, "waiter", ["A1"], "e-retry");
  check("waiter declined while seat is taken", decl.status === 409 && decl.body.reason === "seat_taken");
  await call("POST", `/reservations/${holder.body.reservation_id}/cancel`, { token: tok("holder") });
  const retry = await reserve(showE, "waiter", ["A1"], "e-retry");
  check("same key retried after the seat frees up -> succeeds (a decline leaves no key behind)", is2xx(retry.status) && retry.body.status === "confirmed", JSON.stringify(retry.body));
  const afterCancel = await reserve(showE, "holder", ["A1"], "e-1");
  check("replaying a CANCELLED reservation's key never reports 'confirmed'", afterCancel.status < 500 && afterCancel.body.status !== "confirmed", `${afterCancel.status} ${JSON.stringify(afterCancel.body)}`);
  check("...and does not resurrect the seat from the new owner", (await seatStatus(showE, "A1")) === "confirmed");

  startSection("13. Show isolation", "same seat code in two shows is independent; limits are per show");
  const showF = await newShow(5, 2);
  const showG = await newShow(5, 2);
  trackedShows.push(["F", showF], ["G", showG]);
  check("same user, same seat code, different shows -> both succeed", is2xx((await reserve(showF, "iso", ["A1"], "f-1")).status) && is2xx((await reserve(showG, "iso", ["A1"], "g-1")).status));
  await reserve(showF, "iso", ["A2"], "f-2");
  const fLimit = await reserve(showF, "iso", ["A3"], "f-3");
  check("limit reached in show F -> 409 per_user_limit", fLimit.status === 409 && fLimit.body.reason === "per_user_limit");
  check("...but the same user can still reserve in show G", is2xx((await reserve(showG, "iso", ["A2"], "g-2")).status));

  startSection("14. Cancel races", "parallel cancels; cancel racing new reservations");
  const showH = await newShow(5);
  trackedShows.push(["H", showH]);
  const hr = await reserve(showH, "owner", ["A1"], "h-1");
  const cancels = await Promise.all(Array.from({ length: 20 }, () => call("POST", `/reservations/${hr.body.reservation_id}/cancel`, { token: tok("owner") })));
  check(`20 parallel cancels all succeed (${fmt(tally(cancels))})`, cancels.every((r) => r.status === 200 && r.body.status === "cancelled"));
  check("seat released exactly once (available)", (await seatStatus(showH, "A1")) === "available");
  const hr2 = await reserve(showH, "owner", ["A2"], "h-2");
  const mix = await Promise.all([
    call("POST", `/reservations/${hr2.body.reservation_id}/cancel`, { token: tok("owner") }),
    ...Array.from({ length: 30 }, (_, i) => reserve(showH, `chaser${i}`, ["A2"], `c-${i}`)),
  ]);
  check("cancel racing 30 reservers: zero 5xx", mix.every((r) => r.status < 500), fmt(tally(mix)));
  const winners = mix.slice(1).filter((r) => is2xx(r.status)).length;
  check(`at most one reserver wins A2 (${winners})`, winners <= 1);
  check("final A2 state is consistent with the outcome", (await seatStatus(showH, "A2")) === (winners === 1 ? "confirmed" : "available"));

  startSection("15. Multi-seat overlap (deadlock check)", "60 users request random overlapping pairs in random order, all at once");
  const showI = await newShow(6, 6);
  trackedShows.push(["I", showI]);
  const pick = () => {
    const a = Math.floor(Math.random() * 6) + 1;
    let b = Math.floor(Math.random() * 6) + 1;
    while (b === a) b = Math.floor(Math.random() * 6) + 1;
    return [`A${a}`, `A${b}`];
  };
  const overlap = await Promise.all(Array.from({ length: 60 }, (_, i) => reserve(showI, `pairer${i}`, pick(), `p-${i}`)));
  const ot = tally(overlap);
  check(`zero 5xx / no deadlocks (${fmt(ot)})`, overlap.every((r) => r.status < 500));
  const won = overlap.filter((r) => is2xx(r.status)).length;
  const stI = await call("GET", `/shows/${showI}`);
  check(`confirmed seats == 2 x winning requests (${stI.body.counts.confirmed} == ${won * 2})`, stI.body.counts.confirmed === won * 2);

  startSection("16. Metrics", "counters move by exactly the right amounts (run against an otherwise idle server)");
  const showM = await newShow(3, 2);
  trackedShows.push(["M", showM]);
  const before = await metricsText();
  await reserve(showM, "m1", ["A1"], "m-a");              // +1 confirmed (201)
  await reserve(showM, "m1", ["A1"], "m-a");              // replay: no metric change in reservation counters
  await reserve(showM, "m2", ["A1"], "m-b");              // +1 declined seat_taken (409)
  await reserve(showM, "m1", ["A2", "A3"], "m-c");        // +1 declined per_user_limit (409)
  await reserve(showM, "m1", ["A2"], "m-a");              // +1 declined idempotent_conflict (409)
  const afterM = await metricsText();
  const d = (name: string, l: Record<string, string> = {}) => mval(afterM, name, l) - mval(before, name, l);
  check("reservations_confirmed_total +1 (replay not double counted)", d("reservations_confirmed_total") === 1, `delta ${d("reservations_confirmed_total")}`);
  check("declined{seat_taken} +1", d("reservations_declined_total", { reason: "seat_taken" }) === 1);
  check("declined{per_user_limit} +1", d("reservations_declined_total", { reason: "per_user_limit" }) === 1);
  check("declined{idempotent_conflict} +1", d("reservations_declined_total", { reason: "idempotent_conflict" }) === 1);
  const rt = { route: "/shows/:id/reserve" };
  check("http_requests_total{reserve,201} +2 (new + replay)", d("http_requests_total", { ...rt, status: "201" }) === 2, `delta ${d("http_requests_total", { ...rt, status: "201" })}`);
  check("http_requests_total{reserve,409} +3", d("http_requests_total", { ...rt, status: "409" }) === 3);
  await call("GET", `/shows/${showM}`);
  const gauge = mval(await metricsText(), "seats_available", { show_id: showM });
  check(`seats_available gauge matches DB (${gauge} == 2)`, gauge === 2);
  check("latency histogram exported for the reserve route", mval(afterM, "http_request_duration_seconds_count", rt) > 0);

  startSection("17. Reconciliation", "available + held + confirmed == total for every show created above");
  for (const [label, id] of [["A", showA], ["B", showB], ["C", showC], ["D", showD]] as const) {
    const s = await call("GET", `/shows/${id}`);
    const c = s.body.counts;
    check(`show ${label}: ${c.available}+${c.held}+${c.confirmed} == ${c.total}`, c.available + c.held + c.confirmed === c.total);
  }
  for (const [label, id] of trackedShows) {
    const c = (await call("GET", `/shows/${id}`)).body.counts;
    check(`show ${label}: ${c.available}+${c.held}+${c.confirmed} == ${c.total}`, c.available + c.held + c.confirmed === c.total);
  }

  startSection("18. Server-side view", "the server's own 5xx counter for this whole run");
  const metricsAtEnd = await metricsText();
  const new5xx = sum5xx(metricsAtEnd) - sum5xx(metricsAtStart);
  check(`server recorded ${new5xx} 5xx responses during the run`, new5xx === 0);

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
