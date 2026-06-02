import express from "express";
import CategoryService from "../services/category/categoryService.js";
import { getAllCategories, getCategoryOptions } from "../controllers/categoryController.js";

const router = express.Router();
const categoryService = new CategoryService();

router.get("/get-all", getAllCategories(categoryService));
router.get("/options", getCategoryOptions(categoryService));

export default router;
