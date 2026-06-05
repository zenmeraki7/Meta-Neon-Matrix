import express from "express";
import CategoryService from "../services/category/categoryService.js";
import { getAllCategories, getCategoryOptions } from "../controllers/categoryController.js";
import { subscriptionMiddleware } from "../middleware/subscriptionMiddleware.js";

const router = express.Router();
const categoryService = new CategoryService();

router.get("/get-all", subscriptionMiddleware, getAllCategories(categoryService));
router.get("/options", subscriptionMiddleware, getCategoryOptions(categoryService));

export default router;
