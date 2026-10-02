// Stateless bearer-token auth — no DB lookup (see ARCHITECTURE.md §2: a
// DB-backed auth check would double the connection-pool pressure under a
// 20K-concurrent burst). A token is `<userId>.<hmac-sha256(userId, secret)>`,
// verified in-process. This is a deliberate simplification for the scope
// of this exercise (no signup/login flow) — generate tokens with
// `npm run token -- <userId>`. Documented honestly in WRITEUP.md.
//
// Identity resolved here is the ONLY source of user_id for the rest of the
// request. Handlers never read a user_id-shaped field from the body.
//
// Applied per-route (reserve, cancel), not as a global hook — POST /shows
// uses a separate admin key (adminAuth.ts) and GET /shows/:id needs no
// auth at all, so a single global hook would have to special-case both of
// those anyway. Scoping it per-route is simpler and matches what the spec
// actually requires per endpoint.

import { FastifyRequest, FastifyReply } from "fastify";
import crypto from "crypto";
import { config } from "../config/config";
import { NotAuthenticatedError } from "../errors";

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
  }
}

export function signToken(userId: string): string {
  const sig = crypto
    .createHmac("sha256", config.authTokenSecret)
    .update(userId)
    .digest("hex");
  return `${userId}.${sig}`;
}

function verifyToken(token: string): string {
  const [userId, sig] = token.split(".");
  if (!userId || !sig) {
    throw new NotAuthenticatedError("Malformed token");
  }
  const expected = crypto
    .createHmac("sha256", config.authTokenSecret)
    .update(userId)
    .digest("hex");
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (
    sigBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expectedBuf)
  ) {
    throw new NotAuthenticatedError("Invalid token");
  }
  return userId;
}

export async function requireUserAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Bearer ")) {
    throw new NotAuthenticatedError("Missing Authorization: Bearer <token> header");
  }
  const token = header.slice("Bearer ".length).trim();
  req.userId = verifyToken(token);
}
