// Admission control. Under a 20K-request stampede the bottleneck is the
// bounded DB pool (a handful of connections), not the HTTP layer. Without a
// cap, every extra request just sits in memory waiting for a connection; on a
// small instance that exhausts RAM/CPU and the platform proxy starts
// returning 502s for everything, including requests that would have
// succeeded.
//
// Instead, once MAX_INFLIGHT_REQUESTS are being worked on, further requests
// are answered immediately with 429 + Retry-After. That is a clean,
// retryable "not now" — never a 5xx — and it keeps the process healthy for
// the requests it did admit. It never affects correctness: a shed request
// touched no seat and recorded nothing, so the client can safely retry (and
// idempotency keys make that retry safe).
//
// Health/readiness/metrics are exempt so the platform health check and
// observability keep working while the service is shedding load.

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config/config";
import { httpInflightGauge, httpRequestsShedTotal } from "../metrics/metrics";

const EXEMPT_PATHS = new Set(["/healthz", "/readyz", "/metrics"]);

export function registerLoadShedder(app: FastifyInstance): void {
  let inflight = 0;

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split("?")[0];
    if (EXEMPT_PATHS.has(path)) return;

    if (inflight >= config.maxInflightRequests) {
      httpRequestsShedTotal.inc();
      reply
        .code(429)
        .header("Retry-After", "1")
        .send({ type: "error", reason: "overloaded", message: "Server is busy, please retry" });
      return reply;
    }

    inflight += 1;
    httpInflightGauge.set(inflight);
    // 'close' fires exactly once whether the response finished or the client
    // went away, so the counter can never leak.
    reply.raw.once("close", () => {
      inflight -= 1;
      httpInflightGauge.set(inflight);
    });
  });
}
