import express from "express";
import { getProductsGridController } from "../controllers/gridQueryController.js";

const router = express.Router();

router.get("/", getProductsGridController);

export default router;
