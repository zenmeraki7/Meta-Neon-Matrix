import { Services } from "../services/productService/productFilterService.js";
import { successResponse, errorResponse } from "../utils/responseUtils.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { getCache, setCache } from "../utils/cacheUtils.js";
import { logApiError } from "../utils/errorLogUtils.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";
import { fieldRegistry } from "../services/targeting/registry/fieldRegistry.js";
import { getTargetingVersionBundle } from "../services/targeting/versioning.js";
import { executeProductQuery } from "../services/productService/productQueryCommandService.js";
import { getBulkEditStatus } from "../services/productService/bulkEditStatusService.js";

const productService = new Services();

function mapValueTypeToUiType(valueType) {
  if (valueType === "number") return "number";
  if (valueType === "date") return "date";
  return "string";
}

function mapOperatorToLegacyLabel(operator) {
  const map = {
    EQ: "equals",
    NEQ: "does not equal",
    CONTAINS: "contains",
    NOT_CONTAINS: "does not contain",
    STARTS_WITH: "starts with",
    ENDS_WITH: "ends with",
    LT: "<",
    LTE: "<=",
    GT: ">",
    GTE: ">=",
    IN: "is",
    NOT_IN: "is not",
    IS_EMPTY: "is empty/blank",
    IS_NOT_EMPTY: "is not empty",
    BETWEEN: "between",
  };
  return map[operator] || operator.toLowerCase();
}

function successOptionResponse(message, data) {
  return {
    success: true,
    message,
    count: Array.isArray(data) ? data.length : 0,
    data,
  };
}

export const getProductsWithQuery = async (req, res) => {
  const session = res.locals.shopify?.session;

  try {
    if (!session) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }

    if (req.query?.page && String(req.query.page) !== "1") {
      return res.status(400).json(
        errorResponse("Offset pagination is disabled for product listing. Use cursor pagination."),
      );
    }

    const data = await executeProductQuery({
      shop: session.shop,
      query: req.query,
      body: req.body,
    });

    return res
      .status(200)
      .json(successResponse("Products fetched successfully", data));
  } catch (err) {
    await logApiError({
      shop: session?.shop,
      err,
      req,
      source: "GET /api/products",
    });

    const { statusCode, body } = buildPublicApiErrorResponse(
      err,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
};

export const checkEditStatus = asyncHandler(async (req, res) => {
  const id = req.params.id;
  const session = res.locals.shopify?.session;
  if (!session?.shop) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      { code: "UNAUTHENTICATED" },
      "UNAUTHENTICATED",
    );
    return res.status(statusCode).json(body);
  }

  const data = await getBulkEditStatus({ shop: session.shop, id });
  return res.status(200).json(data);
});

export const getProductTypes = async (req, res) => {
  try {
    const { search = "" } = req.query;
    const session = res.locals.shopify?.session;

    if (!session?.shop) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }

    const shop = session.shop;
    const cacheKey = `${shop}:productTypes:${String(search).toLowerCase()}`;
    const cached = await getCache(cacheKey);

    if (cached) {
      return res
        .status(200)
        .json(successOptionResponse("Product types fetched from cache", cached));
    }

    const productTypes = await productService.getDistinctProductFilterValues({
      shop,
      field: "product_type",
      search,
      take: 20,
    });

    await setCache(cacheKey, productTypes, 300);

    return res.status(200).json(
      successOptionResponse(
        "Product types fetched from product mirror",
        productTypes,
      ),
    );
  } catch (error) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
};

export const getProductFilterValues = async (req, res) => {
  const session = res.locals.shopify?.session;

  try {
    if (!session?.shop) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }

    const field = String(req.params.field || "").trim();
    const search =
      typeof req.query.search === "string" ? req.query.search.trim() : "";

    const data = await productService.getDistinctProductFilterValues({
      shop: session.shop,
      field,
      search,
      take: 20,
    });

    return res
      .status(200)
      .json(successOptionResponse("Product filter values fetched successfully", data));
  } catch (error) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
};

export const getFilterRegistry = async (req, res) => {
  const session = res.locals.shopify?.session;
  try {
    if (!session?.shop) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }

    const versions = getTargetingVersionBundle();
    const fields = Object.values(fieldRegistry)
      .filter((field) => field?.contexts?.includes("PREVIEW"))
      .map((field) => ({
        key: field.key,
        label: field.key,
        type: mapValueTypeToUiType(field.valueType),
        isSearchable: field.valueType === "string",
        operators: Array.isArray(field.operators)
          ? field.operators.map(mapOperatorToLegacyLabel)
          : [],
      }));

    return res.status(200).json({
      success: true,
      data: {
        versions: {
          fieldRegistryVersion: versions.fieldRegistryVersion,
          operatorRegistryVersion: versions.operatorRegistryVersion,
        },
        fields,
      },
    });
  } catch (error) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
};
