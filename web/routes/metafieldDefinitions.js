import express from "express";
import { getMetafieldDefinitionsController } from "../controllers/metafieldDefinitionsController.js";

const router = express.Router();
router.get("/", getMetafieldDefinitionsController);

export default router;
