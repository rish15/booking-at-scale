// POST /shows is the one admin-only endpoint in the spec. A full admin
// auth system is out of scope for this exercise — a static shared key
// (sent as x-admin-key) is the deliberately simple stand-in, same spirit
// as the stateless user token in auth.ts.

import { FastifyRequest, FastifyReply } from "fastify";
import crypto from "crypto";
import { config } from "../config/config";
import { NotAuthorizedError } from "../errors";

export async function requireAdmin(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const provided = req.headers["x-admin-key"];
  if (typeof provided !== "string") {
    throw new NotAuthorizedError("Missing x-admin-key header");
  }
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(config.adminKey);
  if (
    providedBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(providedBuf, expectedBuf)
  ) {
    throw new NotAuthorizedError("Invalid x-admin-key");
  }
}
