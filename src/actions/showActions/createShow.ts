import { withTransaction } from "../../db/pool";
import { config } from "../../config/config";
import { validateCreateShowBody } from "./common/validateCreateShowBody";

export interface CreateShowResult {
  id: string;
  name: string;
  price_paise: number;
  per_user_limit: number;
  seats: { seat_code: string; status: "available" }[];
}

export async function createShow(rawBody: unknown): Promise<CreateShowResult> {
  const { name, seats, price_paise, per_user_limit } = validateCreateShowBody(rawBody);
  const effectiveLimit = per_user_limit ?? config.perUserLimit;

  return withTransaction(async (client) => {
    const showRes = await client.query(
      `INSERT INTO shows (name, price_paise, per_user_limit) VALUES ($1, $2, $3) RETURNING id`,
      [name, price_paise, effectiveLimit]
    );
    const showId = showRes.rows[0].id;

    // Bulk insert — fine as a loop at show-creation time (not the hot
    // reserve path), one show created once, not per-request under burst.
    for (const seatCode of seats) {
      await client.query(
        `INSERT INTO seats (show_id, seat_code, status) VALUES ($1, $2, 'available')`,
        [showId, seatCode]
      );
    }

    return {
      id: showId,
      name,
      price_paise,
      per_user_limit: effectiveLimit,
      seats: seats.map((seat_code) => ({ seat_code, status: "available" as const })),
    };
  });
}
