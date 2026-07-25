import express from "express";
import { sessionStatusStreamController } from "../controllers/sessionStatusController.js";

const router = express.Router();

router.get("/:id/status", sessionStatusStreamController);

export default router;
