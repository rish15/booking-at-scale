export type SeatStatus = "available" | "held" | "confirmed";

export interface Show {
  id: string;
  name: string;
  price_paise: number;
  per_user_limit: number;
  created_at: string;
}

export interface Seat {
  show_id: string;
  seat_code: string;
  status: SeatStatus;
  held_by: string | null;
  expires_at: string | null;
}

export type ReservationStatus = "pending" | "confirmed" | "cancelled";

export interface Reservation {
  id: string;
  show_id: string;
  user_id: string;
  idempotency_key: string;
  request_hash: string;
  status: ReservationStatus;
  amount_paise: number;
  created_at: string;
}

// Attached by the auth middleware — never trust a body-supplied user_id.
export interface AuthenticatedUser {
  userId: string;
}

export interface CreateShowBody {
  name: string;
  seats: string[];
  price_paise: number;
  per_user_limit?: number;
}

export interface ReserveSeatsBody {
  seats: string[];
  idempotency_key: string;
}
