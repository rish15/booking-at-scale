// One-command burst script — the deliverable the spec asks for by name:
// "./burst.sh <BASE_URL> ... prints the outcome distribution (confirmed /
// declined-by-reason / 5xx) and the final reconciliation."
//
// Usage:
//   npm run burst -- <BASE_URL> [totalRequests] [hotSeatRequests]
//   npm run burst -- http://localhost:2000 2000 500
//
// Requires ADMIN_KEY and AUTH_TOKEN_SECRET in the environment, matching
// whatever server you're pointing at (same values it was deployed with).

import "dotenv/config";
import { signToken } from "../src/middlewares/auth";

const BASE_URL = process.argv[2] || "http://localhost:2000";
const TOTAL_REQUESTS = parseInt(process.argv[3] || "2000", 10);
const HOT_SEAT_REQUESTS = parseInt(process.argv[4] || "500", 10);
const SEAT_COUNT = 100;

const ADMIN_KEY = process.env.ADMIN_KEY;
const AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET;

if (!ADMIN_KEY || !AUTH_TOKEN_SECRET) {
  console.error("ADMIN_KEY and AUTH_TOKEN_SECRET must be set in the environment");
  process.exit(1);
}

interface Outcome {
  status: number;
  reason?: string;
}

async function createShow(): Promise<{ id: string; seats: string[] }> {
  const seats = Array.from({ length: SEAT_COUNT }, (_, i) => `A${i + 1}`);
  const res = await fetch(`${BASE_URL}/shows`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-key": ADMIN_KEY! },
    body: JSON.stringify({ name: `burst-${Date.now()}`, seats, price_paise: 25000 }),
  });
  if (!res.ok) {
    throw new Error(`Failed to create show: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string };
  return { id: body.id, seats };
}

async function reserve(
  showId: string,
  userId: string,
  seats: string[],
  idempotencyKey: string
): Promise<Outcome> {
  const token = signToken(userId);
  try {
    const res = await fetch(`${BASE_URL}/shows/${showId}/reserve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ seats, idempotency_key: idempotencyKey }),
    });
    if (res.status === 409) {
      const body = (await res.json()) as { reason?: string };
      return { status: 409, reason: body.reason };
    }
    return { status: res.status };
  } catch {
    return { status: 0 }; // network-level failure — counted separately below
  }
}

async function getShowState(showId: string) {
  const res = await fetch(`${BASE_URL}/shows/${showId}`);
  return res.json() as Promise<{
    counts: { available: number; held: number; confirmed: number; total: number };
  }>;
}

function tally(outcomes: Outcome[]) {
  const summary: Record<string, number> = {};
  for (const o of outcomes) {
    let key: string;
    if (o.status === 0) key = "network_error";
    else if (o.status >= 500) key = `5xx (${o.status})`;
    else if (o.status === 201) key = "confirmed";
    else if (o.status === 409) key = `declined:${o.reason || "unknown"}`;
    else if (o.status === 429) key = "shed:overloaded (429, retryable - server backpressure)";
    else key = `other (${o.status})`;
    summary[key] = (summary[key] || 0) + 1;
  }
  return summary;
}

async function main() {
  console.log(`Target: ${BASE_URL}`);
  console.log(`Creating a fresh show with ${SEAT_COUNT} seats...`);
  const { id: showId, seats } = await createShow();
  console.log(`Show ${showId} created.`);

  const requests: Promise<Outcome>[] = [];

  // Hot-seat storm — many users, same seat ("A1"). Exactly one must win.
  console.log(`Firing ${HOT_SEAT_REQUESTS} concurrent requests at the same seat (A1)...`);
  for (let i = 0; i < HOT_SEAT_REQUESTS; i++) {
    const userId = `hotseat-user-${i}`;
    requests.push(reserve(showId, userId, ["A1"], `hotseat-${i}`));
  }

  // Broad stampede across the remaining seats, plus some genuine
  // idempotent retries (same user, same key, fired twice concurrently).
  const remaining = TOTAL_REQUESTS - HOT_SEAT_REQUESTS;
  console.log(`Firing ${remaining} more requests across the remaining seats...`);
  for (let i = 0; i < remaining; i++) {
    const userId = `user-${i % 500}`; // 500 distinct users, reused to create per-user-limit contention too
    const seat = seats[1 + (i % (seats.length - 1))]; // skip A1, already covered above
    const idempotencyKey = `req-${userId}-${i % 10}`; // some keys intentionally reused -> idempotent replay / conflict paths
    requests.push(reserve(showId, userId, [seat], idempotencyKey));
  }

  const outcomes = await Promise.all(requests);

  console.log("\n--- Outcome distribution ---");
  const summary = tally(outcomes);
  for (const [key, count] of Object.entries(summary)) {
    console.log(`  ${key}: ${count}`);
  }

  console.log("\n--- Reconciliation ---");
  const state = await getShowState(showId);
  const { available, held, confirmed, total } = state.counts;
  const sum = available + held + confirmed;
  console.log(`  available=${available} held=${held} confirmed=${confirmed} total=${total}`);
  console.log(
    sum === total
      ? `  OK: available + held + confirmed (${sum}) == total_seats (${total})`
      : `  MISMATCH: available + held + confirmed (${sum}) != total_seats (${total})`
  );

  const fiveXx = outcomes.filter((o) => o.status >= 500).length;
  console.log(`\n5xx count: ${fiveXx} ${fiveXx === 0 ? "(zero 5xx — pass)" : "(FAIL)"}`);
}

main().catch((err) => {
  console.error("Burst script failed:", err);
  process.exit(1);
});
