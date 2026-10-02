import { FastifyInstance } from "fastify";
import { checkDbConnection } from "../../db/pool";
import { registry } from "../../metrics/metrics";

export const HealthRoutes = (app: FastifyInstance): void => {
  // Liveness — just "is the process up". Render's own platform health
  // check points here, not at /readyz (see ARCHITECTURE.md §6: a transient
  // DB blip shouldn't make the platform flap/restart the instance).
  app.get("/healthz", async (_req, reply) => {
    reply.status(200).send({ type: "success", message: "alive" });
  });

  // Readiness — actually checks the DB dependency, fails closed. Uses a
  // dedicated small pool (healthPool) so it never competes with live
  // request traffic for a connection out of the main bounded pool.
  app.get("/readyz", async (_req, reply) => {
    const dbOk = await checkDbConnection();
    if (!dbOk) {
      reply.status(503).send({ type: "error", message: "database unreachable" });
      return;
    }
    reply.status(200).send({ type: "success", message: "ready" });
  });

  app.get("/metrics", async (_req, reply) => {
    reply.header("Content-Type", registry.contentType);
    reply.send(await registry.metrics());
  });
};
