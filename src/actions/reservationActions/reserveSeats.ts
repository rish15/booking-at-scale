// The critical path. Every statement here is individually atomic by
// construction (conditional UPDATE, advisory lock + live COUNT, INSERT ON
// CONFLICT) — the surrounding transaction gives all-or-nothing rollback,
// not the correctness itself. See ARCHITECTURE.md "Request flow" section
// for the full reasoning behind each step; this is a direct translation
// of that design, not a simplification of it.

import { withTransaction } from "../../db/pool";
import { isUuid } from "../common/isUuid";
import { ResourceNotFoundError, ReservationDeclinedError } from "../../errors";
import { hashReserveRequest } from "./common/hashRequest";
import { validateReserveBody } from "./common/validateReserveBody";
import { reservationsConfirmedTotal, reservationsDeclinedTotal } from "../../metrics/metrics";

export interface ReserveSeatsResult {
  reservation_id: string;
  show_id: string;
  user_id: string;
  seats: string[];
  amount_paise: number;
  status: "confirmed" | "cancelled";
}

export async function reserveSeats(
  showId: string,
  userId: string,
  rawBody: unknown
): Promise<ReserveSeatsResult> {
  if (!isUuid(showId)) {
    throw new ResourceNotFoundError("show", { showId });
  }
  const { seats, idempotency_key } = validateReserveBody(rawBody);
  const requestHash = hashReserveRequest(seats);
  const sortedSeats = [...seats].sort(); // deadlock avoidance — always lock in the same order

  // Counted only AFTER commit: incrementing inside the transaction would
  // over-count if COMMIT itself fails or the transaction is rolled back.
  let newlyConfirmed = false;
  try {
    const result = await withTransaction(async (client) => {
      // 0. Show must exist; grab price + per-user limit for this show.
      const showRes = await client.query(
        `SELECT price_paise, per_user_limit FROM shows WHERE id = $1`,
        [showId]
      );
      if (showRes.rowCount === 0) {
        throw new ResourceNotFoundError("show", { showId });
      }
      const { price_paise: pricePaise, per_user_limit: perUserLimit } = showRes.rows[0];

      // 1. Idempotency — scoped per user (ARCHITECTURE.md Fix 1), so two
      // different users can never collide on the same key string.
      const insertRes = await client.query(
        `INSERT INTO reservations (show_id, user_id, idempotency_key, request_hash, status)
         VALUES ($1, $2, $3, $4, 'pending')
         ON CONFLICT (show_id, user_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [showId, userId, idempotency_key, requestHash]
      );

      if (insertRes.rowCount === 0) {
        // Key already used by this user for this show. Any row found here
        // must already be in a terminal state — a 'pending' row never
        // survives past its own transaction (declines are rolled back
        // entirely, never persisted).
        const existing = await client.query(
          `SELECT id, request_hash, amount_paise, status FROM reservations
           WHERE show_id = $1 AND user_id = $2 AND idempotency_key = $3`,
          [showId, userId, idempotency_key]
        );
        const row = existing.rows[0];
        if (row.request_hash !== requestHash) {
          throw new ReservationDeclinedError(
            "idempotent_conflict",
            "idempotency_key reused with a different request body"
          );
        }
        // Same request, replayed — return the original reservation, don't
        // touch any seats again. Its status is reported as it is NOW: if the
        // user cancelled it since, replaying must say "cancelled", not claim
        // a seat that may already belong to someone else.
        const seatRows = await client.query(
          `SELECT seat_code FROM reservation_seats WHERE reservation_id = $1 ORDER BY seat_code`,
          [row.id]
        );
        return {
          reservation_id: row.id,
          show_id: showId,
          user_id: userId,
          seats: seatRows.rows.map((r) => r.seat_code),
          amount_paise: row.amount_paise,
          status: row.status as "confirmed" | "cancelled",
        };
      }

      const reservationId: string = insertRes.rows[0].id;

      // 2. Per-user limit (ARCHITECTURE.md Fix 2) — transaction-scoped
      // advisory lock serializes only THIS user's own concurrent attempts;
      // other users are never blocked by it. Then the limit is read live
      // off `seats`, so cancel/expiry never need separate bookkeeping to
      // stay in sync (there's nothing to desync).
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `${showId}:${userId}`,
      ]);
      const countRes = await client.query(
        `SELECT COUNT(*)::int AS held_count FROM seats
         WHERE show_id = $1 AND held_by = $2 AND status IN ('held', 'confirmed')`,
        [showId, userId]
      );
      const currentlyHeld = countRes.rows[0].held_count as number;
      if (currentlyHeld + seats.length > perUserLimit) {
        reservationsDeclinedTotal.inc({ reason: "per_user_limit" });
        throw new ReservationDeclinedError(
          "per_user_limit",
          `Requesting ${seats.length} seat(s) would exceed per-user limit of ${perUserLimit} (currently holding ${currentlyHeld})`
        );
      }

      // 3. Seat acquisition — all-or-nothing, sorted order for deadlock
      // avoidance on multi-seat requests. Goes DIRECTLY available →
      // confirmed in one statement, not through an intermediate 'held'
      // state — see the model decision note above/in WRITEUP.md: this
      // exercise's reserve response is synchronous ("status": "confirmed"
      // in the spec's own example, no separate payment step), so there is
      // nothing for a transient hold to wait on. 'held' stays a valid
      // schema state (kept for clarity/extension) but this code path never
      // writes it.
      for (const seatCode of sortedSeats) {
        const updateRes = await client.query(
          `UPDATE seats
           SET status = 'confirmed', held_by = $1
           WHERE show_id = $2 AND seat_code = $3 AND status = 'available'
           RETURNING seat_code`,
          [userId, showId, seatCode]
        );
        if (updateRes.rowCount === 0) {
          reservationsDeclinedTotal.inc({ reason: "seat_taken" });
          throw new ReservationDeclinedError(
            "seat_taken",
            `Seat ${seatCode} is not available`,
            [seatCode]
          );
        }
      }

      // 4. Confirm the reservation row itself.
      const amountPaise = pricePaise * seats.length;
      await client.query(
        `UPDATE reservations SET status = 'confirmed', amount_paise = $1 WHERE id = $2`,
        [amountPaise, reservationId]
      );
      for (const seatCode of sortedSeats) {
        await client.query(
          `INSERT INTO reservation_seats (reservation_id, seat_code) VALUES ($1, $2)`,
          [reservationId, seatCode]
        );
      }

      newlyConfirmed = true;

      return {
        reservation_id: reservationId,
        show_id: showId,
        user_id: userId,
        seats: sortedSeats,
        amount_paise: amountPaise,
        status: "confirmed" as const,
      };
    });
    if (newlyConfirmed) reservationsConfirmedTotal.inc();
    return result;
  } catch (err) {
    if (err instanceof ReservationDeclinedError && err.reason === "idempotent_conflict") {
      reservationsDeclinedTotal.inc({ reason: "idempotent_conflict" });
    }
    throw err;
  }
}
