import { jsonResponse } from "../lib/serialise.js";
import { normalizeProductGridQuery } from "../normalizers/productGridQueryNormalizer.js";
import { normalizeVariantGridQuery } from "../normalizers/variantGridQueryNormalizer.js";
import { productGridQueryUseCase } from "../useCases/productGridQueryUseCase.js";
import { variantGridQueryUseCase } from "../useCases/variantGridQueryUseCase.js";

function getAuthenticatedShop(locals = {}) {
  return String(
    locals?.shopify?.session?.shop ||
      locals?.shop ||
      "",
  ).trim();
}

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
    const shop = getAuthenticatedShop(res.locals || {});
    const source = req.method === "POST" ? req.body || {} : req.query || {};
    const command = normalizeVariantGridQuery(req.params || {}, source, {
      ...res.locals,
      shop,
    });
    const result = await variantGridQueryUseCase.listVariants(command);
    jsonResponse(res, result);
  } catch (error) {
    const statusCode = Number(error?.statusCode || (error?.code === "UNAUTHENTICATED" ? 401 : 500));
    const safeBody =
      statusCode === 400
        ? {
            success: false,
            code: "VALIDATION_FAILED",
            message: "Invalid variants query request.",
          }
        : statusCode === 401
          ? {
              success: false,
              code: "UNAUTHORIZED",
              message: "Please reopen the app from Shopify admin.",
            }
          : {
              success: false,
              code: "VARIANTS_QUERY_FAILED",
              message: "Unable to load product variants.",
            };

    console.error("[variants-query:error]", {
      requestId: req.id || req.get?.("X-Request-Id") || null,
      shop: getAuthenticatedShop(res.locals || {}) || null,
      code: error?.code || null,
      message: error?.message || String(error),
    });

    jsonResponse(res, safeBody, statusCode);
  }
}
