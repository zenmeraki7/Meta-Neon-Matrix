import fs from "fs";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";
import { buildActorContext } from "../utils/operationContextUtils.js";
import { ProductImportCommandService } from "../services/productImport/ProductImportCommandService.js";
import {
  createCsvPreview,
  previewCsvPage,
} from "../services/productImport/productImportPreviewService.js";

const MAX_COLUMN_MAPPING_KEYS = 100;
const MAX_COLUMN_MAPPING_JSON_BYTES = 20_000;
const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  "text/csv",
  "application/vnd.ms-excel",
  "application/csv",
]);
const productImportCommandService = new ProductImportCommandService();

function removeUploadedFile(filePath) {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // no-op
  }
}

function parseColumnMappings(raw) {
  if (!raw) return {};

  if (Buffer.byteLength(String(raw), "utf8") > MAX_COLUMN_MAPPING_JSON_BYTES) {
    const error = new Error("COLUMN_MAPPINGS_TOO_LARGE");
    error.code = "COLUMN_MAPPINGS_TOO_LARGE";
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    const error = new Error("INVALID_COLUMN_MAPPINGS");
    error.code = "INVALID_COLUMN_MAPPINGS";
    throw error;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const error = new Error("INVALID_COLUMN_MAPPINGS");
    error.code = "INVALID_COLUMN_MAPPINGS";
    throw error;
  }

  if (Object.keys(parsed).length > MAX_COLUMN_MAPPING_KEYS) {
    const error = new Error("TOO_MANY_COLUMN_MAPPINGS");
    error.code = "TOO_MANY_COLUMN_MAPPINGS";
    throw error;
  }

  return parsed;
}

function assertUploadBounds(file) {
  if (!file) {
    const error = new Error("CSV_FILE_REQUIRED");
    error.code = "CSV_FILE_REQUIRED";
    throw error;
  }

  if (Number(file.size || 0) > MAX_UPLOAD_SIZE_BYTES) {
    const error = new Error("CSV_FILE_TOO_LARGE");
    error.code = "CSV_FILE_TOO_LARGE";
    throw error;
  }

  const mimeType = String(file.mimetype || "").toLowerCase();
  if (mimeType && !ALLOWED_MIME_TYPES.has(mimeType)) {
    const error = new Error("INVALID_CSV_MIME_TYPE");
    error.code = "INVALID_CSV_MIME_TYPE";
    throw error;
  }
}

export const importCsvController = async (req, res) => {
  try {
    const session = res.locals.shopify?.session;
    if (!session?.shop) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }

    assertUploadBounds(req.file);
    const parsedMappings = parseColumnMappings(req.body?.columnMappings);

    if (!Object.values(parsedMappings).includes("id")) {
      removeUploadedFile(req.file?.path);
      return res.status(400).json({
        success: false,
        code: "PRODUCT_ID_MAPPING_REQUIRED",
        message: "Product ID mapping is required",
      });
    }

    const shop = session.shop;
    const actor = buildActorContext({
      req,
      session,
      fallbackType: "MERCHANT_ADMIN",
    });

    const result = await productImportCommandService.createImportCommand({
      shop,
      actor,
      file: req.file,
      columnMappings: parsedMappings,
      subscription: req.subscription || null,
      idempotencyKey: req.headers["idempotency-key"],
    });

    return res.status(202).json({
      success: true,
      operationId: result.operationId,
      importId: result.importId,
      status: result.status,
    });
  } catch (err) {
    removeUploadedFile(req.file?.path);
    const { statusCode, body } = buildPublicApiErrorResponse(
      err,
      "VALIDATION_FAILED",
    );
    return res.status(statusCode).json(body);
  }
};

export const previewCsvController = async (req, res) => {
  try {
    const session = res.locals.shopify?.session;
    if (!session?.shop) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }

    const uploadToken = String(req.query?.uploadToken || "").trim();
    if (!uploadToken) {
      return res.status(400).json({
        code: "UPLOAD_TOKEN_REQUIRED",
        message: "uploadToken is required",
      });
    }

    const payload = await previewCsvPage({
      shop: session.shop,
      uploadToken,
      cursor: req.query?.cursor,
      limit: req.query?.limit,
    });
    return res.status(200).json(payload);
  } catch (err) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      err,
      "CSV_PREVIEW_FAILED",
    );
    return res.status(statusCode).json(body);
  }
};

export const createCsvPreviewController = async (req, res) => {
  try {
    const session = res.locals.shopify?.session;
    if (!session?.shop) {
      const { statusCode, body } = buildPublicApiErrorResponse(
        { code: "UNAUTHENTICATED" },
        "UNAUTHENTICATED",
      );
      return res.status(statusCode).json(body);
    }

    assertUploadBounds(req.file);

    const payload = await createCsvPreview({
      shop: session.shop,
      file: req.file,
      limit: req.query?.limit,
    });
    return res.status(200).json(payload);
  } catch (err) {
    removeUploadedFile(req.file?.path);
    const { statusCode, body } = buildPublicApiErrorResponse(
      err,
      "CSV_PREVIEW_FAILED",
    );
    return res.status(statusCode).json(body);
  }
};
