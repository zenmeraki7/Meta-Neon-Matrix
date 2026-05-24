import fs from "fs";
import Papa from "papaparse";
import { prisma } from "../config/database.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";
import { buildActorContext } from "../utils/operationContextUtils.js";
import { ProductImportCommandService } from "../services/productImport/ProductImportCommandService.js";

const MAX_COLUMN_MAPPING_KEYS = 100;
const MAX_COLUMN_MAPPING_JSON_BYTES = 20_000;
const MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  "text/csv",
  "application/vnd.ms-excel",
  "application/csv",
]);
const DEFAULT_PREVIEW_LIMIT = 25;
const MAX_PREVIEW_LIMIT = 250;
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

function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const raw = Buffer.from(String(cursor), "base64").toString("utf8");
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function encodeCursor(offset) {
  return Buffer.from(String(Math.max(0, Number(offset) || 0)), "utf8").toString("base64");
}

function clampLimit(limit) {
  const parsed = Number.parseInt(String(limit || DEFAULT_PREVIEW_LIMIT), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PREVIEW_LIMIT;
  return Math.min(parsed, MAX_PREVIEW_LIMIT);
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

    const spreadsheetFile = await prisma.spreadsheetFile.findFirst({
      where: {
        id: uploadToken,
        shop: session.shop,
      },
      select: {
        id: true,
        fileUrl: true,
      },
    });

    if (!spreadsheetFile?.fileUrl) {
      return res.status(404).json({
        code: "UPLOAD_NOT_FOUND",
        message: "CSV upload token not found for this shop",
      });
    }

    const fileContents = await fs.promises.readFile(spreadsheetFile.fileUrl, "utf8");
    const parsed = Papa.parse(fileContents, {
      header: true,
      skipEmptyLines: true,
    });

    if (parsed.errors?.length) {
      return res.status(422).json({
        code: "CSV_PREVIEW_PARSE_FAILED",
        message: parsed.errors[0]?.message || "CSV parse failed",
      });
    }

    const allItems = Array.isArray(parsed.data) ? parsed.data : [];
    const totalCount = allItems.length;
    const limit = clampLimit(req.query?.limit);
    const currentOffset = decodeCursor(req.query?.cursor);
    const start = Math.min(currentOffset, totalCount);
    const end = Math.min(start + limit, totalCount);
    const items = allItems.slice(start, end);

    const hasNextPage = end < totalCount;
    const hasPreviousPage = start > 0;

    return res.status(200).json({
      items,
      pageInfo: {
        hasNextPage,
        hasPreviousPage,
        nextCursor: hasNextPage ? encodeCursor(end) : null,
        previousCursor: hasPreviousPage ? encodeCursor(Math.max(0, start - limit)) : null,
      },
      totalCount,
    });
  } catch (err) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      err,
      "CSV_PREVIEW_FAILED",
    );
    return res.status(statusCode).json(body);
  }
};

