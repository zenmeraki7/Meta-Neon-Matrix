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
import { logApiError } from "../utils/errorLogUtils.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";
import {
  buildAuthenticatedActor,
  requireShopifySession,
} from "./controllerUtils.js";
import {
  buildCreateProductCodeSnippetCommand,
  buildDeleteProductCodeSnippetCommand,
  buildGetProductCodeSnippetCommand,
  buildListProductCodeSnippetsCommand,
  buildPreviewProductCodeSnippetCommand,
  buildSearchSnippetPreviewProductsCommand,
  buildUpdateProductCodeSnippetCommand,
  buildValidateProductCodeSnippetCommand,
} from "../normalizers/productCodeSnippetCommandNormalizer.js";
import {
  toSnippetArchivedDto,
  toSnippetCreatedDto,
  toSnippetDetailDto,
  toSnippetListDto,
  toSnippetPreviewDto,
  toSnippetPreviewProductsDto,
  toSnippetUpdatedDto,
  toSnippetValidationResponseDto,
} from "../dtos/productCodeSnippetDto.js";

export async function createProductCodeSnippetController(req, res) {
  let session;

  try {
    session = requireShopifySession(res);
    const command = buildCreateProductCodeSnippetCommand({
      shop: session.shop,
      body: req.body,
      actor: buildAuthenticatedActor(req, session),
    });
    const data = await createProductCodeSnippet(command);

    return res.status(201).json(toSnippetCreatedDto(data));
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "productCodeSnippetController.create",
    });
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
}

export async function listProductCodeSnippetsController(req, res) {
  let session;

  try {
    session = requireShopifySession(res);
    const command = buildListProductCodeSnippetsCommand({
      shop: session.shop,
      query: req.query,
      actor: buildAuthenticatedActor(req, session),
    });
    const data = await listProductCodeSnippets(command);

    return res.status(200).json(toSnippetListDto(data));
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
    session = requireShopifySession(res);
    const command = buildGetProductCodeSnippetCommand({
      shop: session.shop,
      params: req.params,
      actor: buildAuthenticatedActor(req, session),
    });
    const data = await getProductCodeSnippetById(command);

    return res.status(200).json(toSnippetDetailDto(data));
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "productCodeSnippetController.getById",
    });
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
}

export async function updateProductCodeSnippetController(req, res) {
  let session;

  try {
    session = requireShopifySession(res);
    const command = buildUpdateProductCodeSnippetCommand({
      shop: session.shop,
      params: req.params,
      body: req.body,
      actor: buildAuthenticatedActor(req, session),
    });
    const data = await updateProductCodeSnippet(command);

    return res.status(200).json(toSnippetUpdatedDto(data));
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "productCodeSnippetController.update",
    });
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
}

export async function deleteProductCodeSnippetController(req, res) {
  let session;

  try {
    session = requireShopifySession(res);
    const command = buildDeleteProductCodeSnippetCommand({
      shop: session.shop,
      params: req.params,
      actor: buildAuthenticatedActor(req, session),
    });
    const data = await archiveProductCodeSnippet(command);

    return res.status(200).json(toSnippetArchivedDto(data));
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "productCodeSnippetController.delete",
    });
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
}

export async function validateProductCodeSnippetController(req, res) {
  let session;

  try {
    session = requireShopifySession(res);
    const command = buildValidateProductCodeSnippetCommand({
      shop: session.shop,
      params: req.params,
      actor: buildAuthenticatedActor(req, session),
    });
    const data = await validateProductCodeSnippet(command);
    const responseDto = toSnippetValidationResponseDto(data);

    return res.status(responseDto.statusCode).json(responseDto.body);
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "productCodeSnippetController.validate",
    });
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
}

export async function previewProductCodeSnippetController(req, res) {
  let session;

  try {
    session = requireShopifySession(res);
    const command = buildPreviewProductCodeSnippetCommand({
      shop: session.shop,
      params: req.params,
      body: req.body,
      actor: buildAuthenticatedActor(req, session),
    });
    const data = await previewSavedProductCodeSnippet(command);

    return res.status(200).json(toSnippetPreviewDto(data));
  } catch (error) {
    await logApiError({
      shop: session?.shop,
      err: error,
      req,
      source: "productCodeSnippetController.preview",
    });
    const { statusCode, body } = buildPublicApiErrorResponse(
      error,
      "INTERNAL_ERROR",
    );
    return res.status(statusCode).json(body);
  }
}

export async function searchSnippetPreviewProductsController(req, res) {
  let session;

  try {
    session = requireShopifySession(res);
    const command = buildSearchSnippetPreviewProductsCommand({
      shop: session.shop,
      query: req.query,
      actor: buildAuthenticatedActor(req, session),
    });
    const data = await searchProductsForSnippetPreview(command);

    return res.status(200).json(toSnippetPreviewProductsDto(data));
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
