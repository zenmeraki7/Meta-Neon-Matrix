import express from "express";
import {
  subscribeBillingController,
  syncBillingController,
} from "../controllers/billingController.js";

const router = express.Router();

router.post("/subscribe", subscribeBillingController);
router.post("/sync", syncBillingController);

export default router;
