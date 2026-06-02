import express from "express";
import { getVariantsGridController } from "../controllers/gridQueryController.js";

const router = express.Router();

router.get("/", getVariantsGridController);

export default router;
