import { FastifyRequest, FastifyReply } from "fastify";
import { BaseController } from "../baseController";
import { reservationAction } from "../../actions/reservationActions";

class ReservationController extends BaseController {
  async reserve(): Promise<void> {
    try {
      const { id: showId } = this.req.params as { id: string };
      const payload = await reservationAction.reserveSeats(
        showId,
        this.req.userId,
        this.req.body
      );
      this.respondWithSuccess(payload, 201);
    } catch (err) {
      this.respondWithError(err);
    }
  }

  async cancel(): Promise<void> {
    try {
      const { id: reservationId } = this.req.params as { id: string };
      const payload = await reservationAction.cancelReservation(reservationId, this.req.userId);
      this.respondWithSuccess(payload);
    } catch (err) {
      this.respondWithError(err);
    }
  }
}

export const ReservationControllerHandlers = {
  reserve: async (req: FastifyRequest, reply: FastifyReply) =>
    new ReservationController(req, reply).reserve(),
  cancel: async (req: FastifyRequest, reply: FastifyReply) =>
    new ReservationController(req, reply).cancel(),
};
