import { FastifyInstance } from "fastify";
import { ReservationControllerHandlers } from "../../controllers/reservationController";
import { requireUserAuth } from "../../middlewares/auth";
import { baseRouteUrl } from "../globalVariables";

export const ReservationRoutes = (app: FastifyInstance): void => {
  app.post(
    `${baseRouteUrl}/shows/:id/reserve`,
    { preHandler: requireUserAuth },
    ReservationControllerHandlers.reserve
  );
  app.post(
    `${baseRouteUrl}/reservations/:id/cancel`,
    { preHandler: requireUserAuth },
    ReservationControllerHandlers.cancel
  );
};
