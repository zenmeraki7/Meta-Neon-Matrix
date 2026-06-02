import express from "express";
import {
  ingestFrontendPerformanceEvent,
  ingestWebVitals,
} from "../controllers/rumController.js";

const router = express.Router();

router.post("/web-vitals", ingestWebVitals);
router.post("/frontend-performance-events", ingestFrontendPerformanceEvent);

export default router;
