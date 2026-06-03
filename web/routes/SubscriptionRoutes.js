import express from "express";
import { createSubscriptionController, getPlansController } from "../controllers/subscriptionController.js";
import { validateBody } from "../middleware/validateQuery.js";
import { validateSession } from "../middleware/validateSession.js";
import { subscriptionCreateSchema } from "../validations/controllerRequestSchemas.js";

const router = express.Router();
router.get("/get-plans", validateSession, getPlansController);
router.post("/create-subscription", validateSession, validateBody(subscriptionCreateSchema), createSubscriptionController);
export default router;
