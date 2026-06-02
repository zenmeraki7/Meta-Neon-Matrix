import express from "express";
import {
  getDashboardBootstrap,
  getProductsBootstrap,
} from "../controllers/bootstrapController.js";

const router = express.Router();

router.get("/products", getProductsBootstrap);
router.get("/dashboard", getDashboardBootstrap);

export default router;
