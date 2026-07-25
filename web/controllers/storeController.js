import { logApiError } from "../utils/errorLogUtils.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";
import { getStoreAccessDto } from "../services/storeAccessService.js";

export const getStoreAccess = async (req, res) => {
  const session = res.locals.shopify?.session;

  try {
    if (!session?.shop) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }

    const responseData = await getStoreAccessDto({ session });
    return res.status(200).json(responseData);
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "storeController.getStoreAccess",
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
};
