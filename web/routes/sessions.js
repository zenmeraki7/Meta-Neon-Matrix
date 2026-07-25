import express from "express";
import validateBody from "../middleware/validateBody.js";
import {
  createSessionController,
  discardSessionController,
  getSessionColumnErrorsController,
  getSessionColumnVariantErrorsController,
  getSessionController,
  getSessionPreviewController,
} from "../controllers/sessionController.js";

const router = express.Router();

const createSessionValidation = validateBody({
  rawFilterInput: { type: "object", required: true },
  variantCount: { type: "number", required: true },
});

router.post("/", createSessionValidation, createSessionController);
router.get("/:id", getSessionController);
router.post("/:id/preview", getSessionPreviewController);
router.get("/:id/errors/columns", getSessionColumnErrorsController);
router.get("/:id/errors/column-variants", getSessionColumnVariantErrorsController);
router.post("/:id/discard", discardSessionController);

export default router;
