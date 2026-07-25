import express from "express";
import { createRecurringEditController } from "../controllers/recurringEditController.js";
import { subscriptionMiddleware } from "../middleware/subscriptionMiddleware.js";

const router = express.Router();

router.post("/", subscriptionMiddleware, createRecurringEditController);

export default router;
