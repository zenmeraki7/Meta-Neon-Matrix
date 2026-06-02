import {
  archiveProductCodeSnippet,
  createProductCodeSnippet,
  getProductCodeSnippetById,
  listProductCodeSnippets,
  previewSavedProductCodeSnippet,
  searchProductsForSnippetPreview,
  updateProductCodeSnippet,
  validateProductCodeSnippet,
} from "../services/productCodeSnippetService.js";
import { errorResponse, successResponse } from "../utils/responseUtils.js";
import { logApiError } from "../utils/errorLogUtils.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";

function getSessionOrThrow(res) {
  const session = res.locals.shopify?.session;
  if (!session?.shop) {
    const error = new Error("UNAUTHENTICATED");
    error.code = "UNAUTHENTICATED";
    throw error;
  }
  return session;
}

function getUserFromSession(session) {
  return session?.id || session?.shop || null;
}

export async function createProductCodeSnippetController(req, res) {
  let session;

  try {
    session = getSessionOrThrow(res);
    const data = await createProductCodeSnippet({
      shop: session.shop,
      body: req.body,
      createdBy: getUserFromSession(session),
    });

    return res.status(201).json(successResponse("Snippet created successfully", data));
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "productCodeSnippetController.create",
    });
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
}

export async function listProductCodeSnippetsController(req, res) {
  let session;

  try {
    session = getSessionOrThrow(res);
    const data = await listProductCodeSnippets({
      shop: session.shop,
      query: req.query,
    });

    return res.status(200).json(successResponse("Snippets fetched successfully", data));
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "productCodeSnippetController.list",
    });
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
}

export async function getProductCodeSnippetByIdController(req, res) {
  let session;

  try {
    session = getSessionOrThrow(res);
    const data = await getProductCodeSnippetById({
      shop: session.shop,
      productCodeSnippetId: req.params.id,
    });

    return res.status(200).json(successResponse("Snippet fetched successfully", data));
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "productCodeSnippetController.getById",
    });
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "NOT_FOUND",
    );
    return res.status(statusCode).json(body);
  }
}

export async function updateProductCodeSnippetController(req, res) {
  let session;

  try {
    session = getSessionOrThrow(res);
    const data = await updateProductCodeSnippet({
      shop: session.shop,
      productCodeSnippetId: req.params.id,
      body: req.body,
      updatedBy: getUserFromSession(session),
    });

    return res.status(200).json(successResponse("Snippet updated successfully", data));
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "productCodeSnippetController.update",
    });
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
}

export async function deleteProductCodeSnippetController(req, res) {
  let session;

  try {
    session = getSessionOrThrow(res);
    const data = await archiveProductCodeSnippet({
      shop: session.shop,
      productCodeSnippetId: req.params.id,
      updatedBy: getUserFromSession(session),
    });

    return res.status(200).json(successResponse("Snippet archived successfully", data));
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "productCodeSnippetController.delete",
    });
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
}

export async function validateProductCodeSnippetController(req, res) {
  let session;

  try {
    session = getSessionOrThrow(res);
    const data = await validateProductCodeSnippet({
      shop: session.shop,
      productCodeSnippetId: req.params.id,
    });

    if (data.validationStatus === "VALID") {
      return res
        .status(200)
        .json(successResponse("Snippet validation completed", data));
    }

    return res
      .status(422)
      .json(errorResponse("Snippet validation failed", data));
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "productCodeSnippetController.validate",
    });
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
}

export async function previewProductCodeSnippetController(req, res) {
  let session;

  try {
    session = getSessionOrThrow(res);
    const data = await previewSavedProductCodeSnippet({
      shop: session.shop,
      productCodeSnippetId: req.params.id,
      productId: req.body.productId,
    });

    return res.status(200).json(successResponse("Snippet preview completed", data));
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "productCodeSnippetController.preview",
    });
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
}

export async function searchSnippetPreviewProductsController(req, res) {
  let session;

  try {
    session = getSessionOrThrow(res);
    const data = await searchProductsForSnippetPreview({
      shop: session.shop,
      search: req.query.search,
      limit: req.query.limit,
    });

    return res.status(200).json(successResponse("Products fetched successfully", data));
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "productCodeSnippetController.searchProducts",
    });
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
}
