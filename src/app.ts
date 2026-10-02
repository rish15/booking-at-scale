import Fastify from "fastify";
import { config } from "./config/config";
import { Routes } from "./routes";
import { registerApiLogger } from "./middlewares/apiLogger";
import { mapErrorToResponse } from "./errors/mapErrorToResponse";

const app = Fastify({ logger: false }); // apiLogger hook does our own structured logging

// CORS — minimal, no extra dependency needed for a JSON API with no browser UI.
app.addHook("onRequest", async (_req, reply) => {
  reply.header("Access-Control-Allow-Origin", "*");
});

registerApiLogger(app);
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
