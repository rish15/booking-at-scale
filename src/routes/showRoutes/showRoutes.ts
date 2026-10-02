import { FastifyInstance } from "fastify";
import { ShowControllerHandlers } from "../../controllers/showController";
import { requireAdmin } from "../../middlewares/adminAuth";
import { baseRouteUrl } from "../globalVariables";

export const ShowRoutes = (app: FastifyInstance): void => {
  app.post(
    `${baseRouteUrl}/shows`,
    { preHandler: requireAdmin },
    ShowControllerHandlers.createShow
  );
  app.get(`${baseRouteUrl}/shows/:id`, ShowControllerHandlers.getShow);
};
