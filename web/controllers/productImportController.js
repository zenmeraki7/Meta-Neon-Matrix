import fs from "fs";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";
import { buildActorContext } from "../utils/operationContextUtils.js";
import { ProductImportCommandService } from "../services/productImport/ProductImportCommandService.js";
import {
  createCsvPreview,
  previewCsvPage,
} from "../services/productImport/productImportPreviewService.js";
import {
  buildCreateCsvPreviewCommand,
  buildCreateProductImportCommand,
  buildPreviewCsvPageCommand,
} from "../normalizers/productImportCommandNormalizer.js";

const productImportCommandService = new ProductImportCommandService();

function removeUploadedFile(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // no-op
  }
}

function requireShopifySession(res) {
  const session = res.locals?.shopify?.session;
  if (!session?.shop) {
    const error = new Error("Authentication required");
    error.code = "UNAUTHENTICATED";
    throw error;
  }
  return session;
}

function buildActor(req, session) {
  return buildActorContext({
    req,
    session,
    fallbackType: "MERCHANT_ADMIN",
  });
}

function getIdempotencyKey(req) {
  return req.get("Idempotency-Key") || null;
}

function buildContext(req, session) {
  return Object.freeze({
    shop: session.shop,
    actor: buildActor(req, session),
    subscription: req.subscription || null,
  });
}

function handleControllerError(res, error, fallbackCode) {
  const { statusCode, body } = buildPublicApiErrorResponse(error, fallbackCode);
  return res.status(statusCode).json(body);
}

export const importCsvController = async (req, res) => {
  try {
    const session = requireShopifySession(res);
    const command = buildCreateProductImportCommand({
      file: req.file,
      body: req.body || {},
      idempotencyKey: getIdempotencyKey(req),
      context: buildContext(req, session),
    });

    const result = await productImportCommandService.createImportCommand(command);

    return res.status(202).json({
      success: true,
      operationId: result.operationId,
      importId: result.importId,
      status: result.status,
    });
  } catch (error) {
    removeUploadedFile(req.file?.path);
    return handleControllerError(res, error, "PRODUCT_IMPORT_FAILED");
  }
};

export const previewCsvController = async (req, res) => {
  try {
    const session = requireShopifySession(res);

    const command = buildPreviewCsvPageCommand({
      query: req.query || {},
      context: buildContext(req, session),
    });

    const payload = await previewCsvPage({
      shop: command.shop,
      uploadToken: command.uploadToken,
      cursor: command.cursor,
      limit: command.limit,
    });
    return res.status(200).json(payload);
  } catch (error) {
    return handleControllerError(res, error, "CSV_PREVIEW_FAILED");
  }
};

export const createCsvPreviewController = async (req, res) => {
  try {
    const session = requireShopifySession(res);

    const command = buildCreateCsvPreviewCommand({
      file: req.file,
      query: req.query || {},
      idempotencyKey: getIdempotencyKey(req),
      context: buildContext(req, session),
    });

    const payload = await createCsvPreview({
      shop: command.shop,
      file: command.file,
      limit: command.limit,
      idempotencyKey: command.idempotencyKey,
    });

    const statusCode = payload?.durable ? 202 : 200;
    return res.status(statusCode).json(payload);
  } catch (error) {
    removeUploadedFile(req.file?.path);
    return handleControllerError(res, error, "CSV_PREVIEW_FAILED");
  }
};
