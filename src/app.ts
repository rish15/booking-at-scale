import Fastify from "fastify";
import { config } from "./config/config";
import { Routes } from "./routes";
import { registerApiLogger } from "./middlewares/apiLogger";
import { registerLoadShedder } from "./middlewares/loadShedder";
import { mapErrorToResponse } from "./errors/mapErrorToResponse";

const app = Fastify({
  logger: false, // apiLogger hook does our own structured logging
  // Platform proxies (Render, most load balancers) hold idle upstream
  // connections open for up to ~60s. If Node closes an idle keep-alive
  // socket first (default 5s), the proxy can reuse a dead connection and
  // answer 502. Keep ours open longer than the proxy's.
  keepAliveTimeout: 65_000,
});
// Node requires headersTimeout > keepAliveTimeout.
app.server.headersTimeout = 66_000;

// CORS — minimal, no extra dependency needed for a JSON API with no browser UI.
app.addHook("onRequest", async (_req, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
});

// Tolerate an empty body when Content-Type is application/json (a plain
// POST like /reservations/:id/cancel has nothing to send). Fastify's default
// parser rejects that; malformed JSON still becomes a clean 400.
app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
  if (!body || body === "") return done(null, undefined);
  try {
    done(null, JSON.parse(body as string));
  } catch {
    const err = new Error("Malformed JSON body") as Error & { statusCode: number };
    err.statusCode = 400;
    done(err, undefined);
  }
});

registerApiLogger(app);
registerLoadShedder(app); // after the logger so shed responses are still logged/counted
// User auth (requireUserAuth) and admin auth (requireAdmin) are applied
// per-route in routes/ — see the comment at the top of middlewares/auth.ts
// for why this isn't a single global hook.

// Global error handler — catches anything a controller's own try/catch
// didn't (auth/admin-auth preHandler failures, Fastify's own body-parsing
// errors, anything unexpected). Same mapping baseController uses, so an
// auth failure gets a clean 401/403, never Fastify's default 500.
app.setErrorHandler((err, _req, reply) => {
  const { status, body } = mapErrorToResponse(err);
  reply.status(status).send(body);
});

Routes.HealthRoutes(app);
Routes.ShowRoutes(app);
Routes.ReservationRoutes(app);

const start = async () => {
  try {
    // 0.0.0.0, not localhost/127.0.0.1 — required for the process to be
    // reachable from outside the container (Docker, Render).
    await app.listen({ port: config.port, host: "0.0.0.0" });
    // eslint-disable-next-line no-console
    console.log(`Server running on ${config.port} in ${config.env} environment`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  }
};

start();

export default app;
