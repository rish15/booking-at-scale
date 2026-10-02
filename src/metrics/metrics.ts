// Per ARCHITECTURE.md §7 — the minimum set the spec asks for:
// reservations confirmed (counter), declined by reason (counter), seats
// available (gauge). All in-process/in-memory — no extra network hop, so
// this never competes with the DB connection pool.

import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const reservationsConfirmedTotal = new client.Counter({
  name: "reservations_confirmed_total",
  help: "Total reservations successfully confirmed",
  registers: [registry],
});

export const reservationsDeclinedTotal = new client.Counter({
  name: "reservations_declined_total",
  help: "Total reservations declined, labeled by reason",
  labelNames: ["reason"] as const,
  registers: [registry],
});

export const seatsAvailableGauge = new client.Gauge({
  name: "seats_available",
  help: "Current available seat count for a show",
  labelNames: ["show_id"] as const,
  registers: [registry],
});
