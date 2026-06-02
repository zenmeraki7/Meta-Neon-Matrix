import express from "express";
import {
  columnApplyController,
  stageChangesController,
} from "../controllers/sessionWorkflowController.js";

const router = express.Router();
router.post("/:id/changes", stageChangesController);
router.post("/:id/changes/column-apply", columnApplyController);

export default router;
