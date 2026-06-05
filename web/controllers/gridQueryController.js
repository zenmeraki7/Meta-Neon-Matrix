import { jsonResponse } from "../lib/serialise.js";
import { normalizeProductGridQuery } from "../normalizers/productGridQueryNormalizer.js";
import { normalizeVariantGridQuery } from "../normalizers/variantGridQueryNormalizer.js";
import { productGridQueryUseCase } from "../useCases/productGridQueryUseCase.js";
import { variantGridQueryUseCase } from "../useCases/variantGridQueryUseCase.js";

export async function getProductsGridController(req, res) {
  try {
    const command = normalizeProductGridQuery(req.params || {}, req.query || {}, res.locals || {});
    const result = await productGridQueryUseCase.listProducts(command);
    jsonResponse(res, result);
  } catch (error) {
    const statusCode = Number(error?.statusCode || 500);
    jsonResponse(
      res,
      { error: error?.message || "Failed to load products", ...(error?.code ? { code: error.code } : {}) },
      statusCode,
    );
  }
}

export async function getVariantsGridController(req, res) {
  try {
    const command = normalizeVariantGridQuery(req.params || {}, req.query || {}, res.locals || {});
    const result = await variantGridQueryUseCase.listVariants(command);
    jsonResponse(res, result);
  } catch (error) {
    const statusCode = Number(error?.statusCode || 500);
    jsonResponse(
      res,
      { error: error?.message || "Failed to load variants", ...(error?.code ? { code: error.code } : {}) },
      statusCode,
    );
  }
}
