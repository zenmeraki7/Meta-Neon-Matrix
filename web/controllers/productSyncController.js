import { asyncHandler } from "../utils/asyncHandler.js";
import { ProductSyncCommandService } from "../services/productSync/ProductSyncCommandService.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";

const productSyncCommandService = new ProductSyncCommandService();

export const clearProductTypes = asyncHandler(async (req, res) => {
  const session = res.locals?.shopify?.session;
  if (!session?.shop) {
    return res.status(401).json({
      success: false,
      code: "UNAUTHENTICATED",
      message: "Session expired",
    });
  }

  try {
    const result = await productSyncCommandService.createClearProductTypesCommand({
      shop: session.shop,
    });
    return res.status(202).json({
      success: true,
      operationId: result.operationId,
      status: result.status,
    });
  } catch (error) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
});

