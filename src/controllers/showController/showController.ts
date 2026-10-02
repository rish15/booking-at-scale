import { FastifyRequest, FastifyReply } from "fastify";
import { BaseController } from "../baseController";
import { showAction } from "../../actions/showActions";

class ShowController extends BaseController {
  async createShow(): Promise<void> {
    try {
      const payload = await showAction.createShow(this.req.body);
      this.respondWithSuccess(payload, 201);
    } catch (err) {
      this.respondWithError(err);
    }
  }

  async getShow(): Promise<void> {
    try {
      const { id } = this.req.params as { id: string };
      const payload = await showAction.getShow(id);
      this.respondWithSuccess(payload);
    } catch (err) {
      this.respondWithError(err);
    }
  }
}

export const ShowControllerHandlers = {
  createShow: async (req: FastifyRequest, reply: FastifyReply) =>
    new ShowController(req, reply).createShow(),
  getShow: async (req: FastifyRequest, reply: FastifyReply) =>
    new ShowController(req, reply).getShow(),
};
