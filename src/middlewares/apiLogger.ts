// Fastify hook version of the template's apiLogger middleware — structured
// JSON logs with a correlation/request id, per the deliverables list
// ("structured logs with a correlation/request id").

import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import crypto from "crypto";

declare module "fastify" {
  interface FastifyRequest {
    requestId: string;
    startTimeNs: bigint;
  }
}

export function registerApiLogger(app: FastifyInstance): void {
  app.addHook("onRequest", async (req: FastifyRequest) => {
    req.requestId =
      (req.headers["x-request-id"] as string | undefined) ||
      crypto.randomBytes(16).toString("hex");
    req.startTimeNs = process.hrtime.bigint();
  });

  app.addHook("onResponse", async (req: FastifyRequest, reply: FastifyReply) => {
    const elapsedMs = Number(process.hrtime.bigint() - req.startTimeNs) / 1e6;
    const logData = {
      requestId: req.requestId,
      method: req.method,
      url: req.url,
      statusCode: reply.statusCode,
      apiLatencyMs: Math.round(elapsedMs * 100) / 100,
      calledAt: new Date().toISOString(),
      env: process.env.NODE_ENV,
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(logData));
  });
}
