import express from "express";
import { createSubscriptionController, getPlansController } from "../controllers/subscriptionController.js";
import { validateBody } from "../middleware/validateQuery.js";
import { subscriptionCreateSchema } from "../validations/controllerRequestSchemas.js";

const router = express.Router();
router.get("/get-plans",getPlansController)
router.post("/create-subscription", validateBody(subscriptionCreateSchema), createSubscriptionController);
export default router;
