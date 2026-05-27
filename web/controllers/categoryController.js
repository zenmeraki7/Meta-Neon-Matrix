import CategoryService from "../services/category/categoryService.js";
import { logApiError } from "../utils/errorLogUtils.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";

const categoryService = new CategoryService();

export const getAllCategories = async (req, res) => {
  const session = res.locals?.shopify?.session;
  try {
    if (!session?.shop) {
      return res.status(401).json({
        success: false,
        code: "UNAUTHENTICATED",
        message: "Session expired",
      });
    }

    const isNameOnly = req.query.isNameOnly === "true";
    const search =
      typeof req.query.search === "string" && req.query.search.trim().length > 0
        ? req.query.search.trim()
        : "";
    const limit = req.query.limit;

    const categories = await categoryService.getAllCategories({
      session,
      search,
      isNameOnly,
      limit,
    });

    return res.status(200).json({
      success: true,
      search: search || null,
      count: categories.length,
      data: categories,
    });
  } catch (err) {
    await logApiError({
      shop: session?.shop,
      err,
      req,
      source: "categoryController.getAllCategories",
    });
    const { statusCode, body } = buildPublicApiErrorResponse(
      err,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
};

