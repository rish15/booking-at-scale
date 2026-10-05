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

// HTTP-level metrics: the 5xx rate is the headline alert for this service
// ("zero 5xx" is the bar), so it has to be directly observable. `route` is
// the route PATTERN (/shows/:id/reserve), never the raw URL, to keep label
// cardinality bounded.
export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "HTTP responses by method, route pattern and status code",
  labelNames: ["method", "route", "status"] as const,
  registers: [registry],
});

export const httpRequestDurationSeconds = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency by method and route pattern",
  labelNames: ["method", "route"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});
