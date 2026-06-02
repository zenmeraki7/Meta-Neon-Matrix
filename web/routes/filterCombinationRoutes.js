import express from "express";
import FilterCombinationService from "../services/filterCombination/FilterCombinationService.js";
import {
  addFilterCombination,
  getFilterCombinations,
  updateFilterCombination,
  deleteFilterCombination,
} from "../controllers/filterCombinationController.js";

const router = express.Router();
const filterCombinationService = new FilterCombinationService();

router.post(
  "/filter-combinations",
  addFilterCombination(filterCombinationService),
);

router.get(
  "/filter-combinations",
  getFilterCombinations(filterCombinationService),
);

router.put(
  "/filter-combinations/:id",
  updateFilterCombination(filterCombinationService),
);

router.delete(
  "/filter-combinations/:id",
  deleteFilterCombination(filterCombinationService),
);

export default router;
