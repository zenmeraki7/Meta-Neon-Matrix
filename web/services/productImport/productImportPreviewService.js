import fs from "fs";
import Papa from "papaparse";
import { db } from "../../repositories/repositoryDb.js";
import {
  buildIdempotencyRequestHash,
  IdempotencyStoreService,
} from "../idempotency/IdempotencyStoreService.js";

const DEFAULT_PREVIEW_LIMIT = 25;
const MAX_PREVIEW_LIMIT = 250;
const MAX_PREVIEW_ROWS = 5000;
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
const DEFAULT_PREVIEW_PARSE_TIMEOUT_MS = 15_000;
const PREVIEW_PARSE_TIMEOUT_MS = Math.max(
  DEFAULT_PREVIEW_PARSE_TIMEOUT_MS,
  Number.parseInt(process.env.CSV_PREVIEW_PARSE_TIMEOUT_MS || "", 10) || 0,
);
const idempotencyStore = new IdempotencyStoreService(db);

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

function parseCsvRows(fileContents) {
  const parsed = Papa.parse(fileContents, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
    transform: (value) => {
      if (value === null || value === undefined) return "";
      return String(value).trim();
    },
  });

  if (parsed.errors?.length) {
    const error = new Error(parsed.errors[0]?.message || "CSV parse failed");
    error.code = "CSV_PREVIEW_PARSE_FAILED";
    throw error;
  }

  const items = Array.isArray(parsed.data) ? parsed.data : [];
  if (items.length > MAX_PREVIEW_ROWS) {
    const error = new Error("CSV_PREVIEW_ROW_LIMIT_EXCEEDED");
    error.code = "CSV_PREVIEW_ROW_LIMIT_EXCEEDED";
    throw error;
  }

  return {
    items,
    headers: Array.isArray(parsed.meta?.fields) ? parsed.meta.fields : [],
  };
}

function buildPreviewResponse({ allItems, headers, cursor, limit }) {
  const totalCount = allItems.length;
  const start = Math.min(cursor, totalCount);
  const end = Math.min(start + limit, totalCount);
  const items = allItems.slice(start, end);
  const hasNextPage = end < totalCount;
  const hasPreviousPage = start > 0;

  return {
    items,
    headers,
    pageInfo: {
      hasNextPage,
      hasPreviousPage,
      nextCursor: hasNextPage ? encodeCursor(end) : null,
      previousCursor: hasPreviousPage ? encodeCursor(Math.max(0, start - limit)) : null,
    },
    totalCount,
  };
}

async function parseCsvWithGuardrails(filePath) {
  const stat = await fs.promises.stat(filePath);
  if (Number(stat.size || 0) > MAX_PREVIEW_BYTES) {
    const error = new Error("CSV_FILE_TOO_LARGE");
    error.code = "CSV_FILE_TOO_LARGE";
    throw error;
  }

  const startedAt = Date.now();
  const fileContents = await fs.promises.readFile(filePath, "utf8");
  const parsed = parseCsvRows(fileContents);

  if (Date.now() - startedAt > PREVIEW_PARSE_TIMEOUT_MS) {
    const error = new Error("CSV_PREVIEW_TIMEOUT");
    error.code = "CSV_PREVIEW_TIMEOUT";
    throw error;
  }

  return parsed;
}

export async function createCsvPreview({ shop, file, limit, idempotencyKey }) {
  const idemKey = String(idempotencyKey || "").trim();
  if (!idemKey) {
    const error = new Error("IDEMPOTENCY_KEY_REQUIRED");
    error.code = "IDEMPOTENCY_KEY_REQUIRED";
    throw error;
  }
  const begin = await idempotencyStore.begin({
    shop,
    scope: "CSV_PREVIEW_CREATE",
    key: idemKey,
    requestHash: buildIdempotencyRequestHash({
      shop,
      operationType: "CSV_PREVIEW_CREATE",
      fileName: file?.originalname || null,
      size: Number(file?.size || 0),
      limit: Number(limit || 0),
    }),
  });
  if (begin.mode === "replay") {
    return {
      ...begin.response,
      durable: begin.response?.durable !== false,
    };
  }

  const previewDoc = await db.spreadsheetFile.create({
    data: {
      shop,
      fileUrl: file.path,
      originalFilename: file.originalname || null,
      status: "UPLOADED",
    },
    select: {
      id: true,
      fileUrl: true,
    },
  });

  const { items: allItems, headers } = await parseCsvWithGuardrails(previewDoc.fileUrl);
  const normalizedLimit = clampLimit(limit);
  const payload = buildPreviewResponse({
    allItems,
    headers,
    cursor: 0,
    limit: normalizedLimit,
  });

  const response = {
    uploadToken: previewDoc.id,
    durable: true,
    ...payload,
  };
  await idempotencyStore.complete({
    recordId: begin.recordId,
    response,
  });
  return response;
}

export async function previewCsvPage({ shop, uploadToken, cursor, limit }) {
  const spreadsheetFile = await db.spreadsheetFile.findFirst({
    where: {
      id: uploadToken,
      shop,
    },
    select: {
      id: true,
      fileUrl: true,
    },
  });

  if (!spreadsheetFile?.fileUrl) {
    const error = new Error("UPLOAD_NOT_FOUND");
    error.code = "UPLOAD_NOT_FOUND";
    throw error;
  }

  const { items: allItems, headers } = await parseCsvWithGuardrails(spreadsheetFile.fileUrl);
  const normalizedLimit = clampLimit(limit);
  const currentOffset = decodeCursor(cursor);

  return buildPreviewResponse({
    allItems,
    headers,
    cursor: currentOffset,
    limit: normalizedLimit,
  });
}

