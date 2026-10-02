// Same shape as the template's BaseController, translated to Fastify's
// (request, reply) and TS. Controllers stay thin — they call into an
// action, then map the result/error to an HTTP response. No business
// logic lives here.

import { FastifyRequest, FastifyReply } from "fastify";
import { mapErrorToResponse } from "../errors/mapErrorToResponse";

export class BaseController {
  protected req: FastifyRequest;
  protected reply: FastifyReply;

  constructor(req: FastifyRequest, reply: FastifyReply) {
    this.req = req;
    this.reply = reply;
  }

  protected respondWithSuccess(payload: unknown, status = 200): void {
    this.reply.status(status).send(payload);
  }

  protected respondWithError(err: unknown): void {
    const { status, body } = mapErrorToResponse(err);
    this.reply.status(status).send(body);
  }
}
