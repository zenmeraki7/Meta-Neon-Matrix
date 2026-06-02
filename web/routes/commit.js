import express from "express";
import { commitSessionController } from "../controllers/sessionWorkflowController.js";

const router = express.Router();
router.post("/:id/commit", commitSessionController);

export default router;
