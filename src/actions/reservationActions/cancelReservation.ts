// Owner-only cancel. Idempotent by design (ARCHITECTURE.md): cancelling an
// already-cancelled reservation finds 0 matching rows in the conditional
// UPDATE and returns success as a no-op, never an error — a client retry
// of a cancel call must not surface as a failure.

import { withTransaction } from "../../db/pool";
import { NotAuthorizedError, ResourceNotFoundError } from "../../errors";

export interface CancelResult {
  reservation_id: string;
  status: "cancelled";
}

export async function cancelReservation(
  reservationId: string,
  userId: string
): Promise<CancelResult> {
  return withTransaction(async (client) => {
    const resRow = await client.query(
      `SELECT id, show_id, user_id, status FROM reservations WHERE id = $1`,
      [reservationId]
    );
    if (resRow.rowCount === 0) {
      throw new ResourceNotFoundError("reservation", { reservationId });
    }
    const reservation = resRow.rows[0];
    if (reservation.user_id !== userId) {
      // Identity is token-derived — a user can only ever cancel their own
      // holds, regardless of what the URL asks for.
      throw new NotAuthorizedError("Cannot cancel another user's reservation");
    }

    // Idempotent no-op if already cancelled.
    if (reservation.status === "cancelled") {
      return { reservation_id: reservationId, status: "cancelled" as const };
    }

    const seatRows = await client.query(
      `SELECT seat_code FROM reservation_seats WHERE reservation_id = $1`,
      [reservationId]
    );
    const seatCodes: string[] = seatRows.rows.map((r) => r.seat_code);

    if (seatCodes.length > 0) {
      // Conditional release, not read-then-write — a release must never
      // resurrect a seat already reassigned/confirmed to someone else,
      // which this guard (held_by must still match this reservation's
      // owner) makes impossible even under concurrency.
      await client.query(
        `UPDATE seats SET status = 'available', held_by = NULL
         WHERE show_id = $1 AND seat_code = ANY($2::text[]) AND held_by = $3`,
        [reservation.show_id, seatCodes, userId]
      );
    }

    await client.query(`UPDATE reservations SET status = 'cancelled' WHERE id = $1`, [
      reservationId,
    ]);

    return { reservation_id: reservationId, status: "cancelled" as const };
  });
}
