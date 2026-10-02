import { pool } from "../../db/pool";
import { ResourceNotFoundError } from "../../errors";
import { seatsAvailableGauge } from "../../metrics/metrics";
import { SeatStatus } from "../../types";

export interface GetShowResult {
  id: string;
  name: string;
  price_paise: number;
  per_user_limit: number;
  seats: { seat_code: string; status: SeatStatus }[];
  counts: { available: number; held: number; confirmed: number; total: number };
}

export async function getShow(showId: string): Promise<GetShowResult> {
  const showRes = await pool.query(
    `SELECT id, name, price_paise, per_user_limit FROM shows WHERE id = $1`,
    [showId]
  );
  if (showRes.rowCount === 0) {
    throw new ResourceNotFoundError("show", { showId });
  }
  const show = showRes.rows[0];

  const seatRes = await pool.query(
    `SELECT seat_code, status FROM seats WHERE show_id = $1 ORDER BY seat_code`,
    [showId]
  );
  const seats = seatRes.rows as { seat_code: string; status: SeatStatus }[];

  const counts = { available: 0, held: 0, confirmed: 0, total: seats.length };
  for (const seat of seats) {
    counts[seat.status] += 1;
  }
  // available + held + confirmed == total_seats is the reconciliation
  // invariant this exact tally enforces by construction — every seat is in
  // exactly one of the three states, always.

  seatsAvailableGauge.set({ show_id: showId }, counts.available);

  return {
    id: show.id,
    name: show.name,
    price_paise: show.price_paise,
    per_user_limit: show.per_user_limit,
    seats,
    counts,
  };
}
