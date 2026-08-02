import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { db as defaultDb } from "../../repositories/repositoryDb.js";
import logger from "../../utils/loggerUtils.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const ALLOWED_CLOUDINARY_HOST = "res.cloudinary.com";
const DOWNLOADABLE_STATUSES = new Set(["COMPLETED"]);

export class ExportDownloadError extends Error {
  constructor(code, message, statusCode, details = {}) {
    super(message || code);
    this.name = "ExportDownloadError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function sanitizeAttachmentFilename(filename) {
  const fallback = "export.csv";
  const value = String(filename || fallback)
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F"\\/:*?<>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const withoutPaths = value.split(/[\\/]/).pop() || fallback;
  const safe = withoutPaths
    .replace(/^\.+/, "")
    .slice(0, 180)
    .trim() || fallback;
  return safe.toLowerCase().endsWith(".csv") ? safe : `${safe}.csv`;
}

function encode5987Value(value) {
  return encodeURIComponent(value)
    .replace(/['()]/g, escape)
    .replace(/\*/g, "%2A");
}

export function buildContentDisposition(filename) {
  const safeFilename = sanitizeAttachmentFilename(filename);
  const asciiFallback = safeFilename.replace(/[^\x20-\x7E]/g, "_");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encode5987Value(safeFilename)}`;
}

export function validateStoredCloudinaryUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new ExportDownloadError(
      "EXPORT_FILE_REFERENCE_MISSING",
      "Export file is not available.",
      409,
    );
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ExportDownloadError(
      "EXPORT_FILE_REFERENCE_INVALID",
      "Export file reference is invalid.",
      409,
    );
  }

  const path = parsed.pathname || "";
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== ALLOWED_CLOUDINARY_HOST ||
    !/^\/[^/]+\/raw\/upload\//.test(path)
  ) {
    throw new ExportDownloadError(
      "EXPORT_FILE_REFERENCE_UNSAFE",
      "Export file reference is invalid.",
      409,
    );
  }

  return parsed.toString();
}

export function mapUpstreamStatus(status) {
  if (status === 404 || status === 410) return 404;
  if (status >= 500) return 502;
  return 502;
}

export async function findDownloadableExport({ exportJobId, shop, db = defaultDb }) {
  if (!exportJobId || typeof exportJobId !== "string") {
    throw new ExportDownloadError("VALIDATION_FAILED", "Invalid export id.", 400);
  }
  if (!shop || typeof shop !== "string") {
    throw new ExportDownloadError("UNAUTHENTICATED", "Authentication required.", 401);
  }

  const exportJob = await db.exportJob.findFirst({
    where: { id: exportJobId, shop },
    select: {
      id: true,
      shop: true,
      generatedFilename: true,
      downloadUrl: true,
      statusNormalized: true,
      executionStateNormalized: true,
    },
  });

  if (!exportJob) {
    throw new ExportDownloadError("EXPORT_NOT_FOUND", "Export not found.", 404);
  }

  const normalizedStatus = String(
    exportJob.statusNormalized || "UNKNOWN",
  ).toUpperCase();
  if (!DOWNLOADABLE_STATUSES.has(normalizedStatus)) {
    throw new ExportDownloadError(
      "EXPORT_NOT_READY",
      "Export file is not available yet.",
      409,
      { status: normalizedStatus || null },
    );
  }

  return {
    ...exportJob,
    downloadUrl: validateStoredCloudinaryUrl(exportJob.downloadUrl),
    filename: sanitizeAttachmentFilename(exportJob.generatedFilename),
  };
}

function responseBodyToNodeStream(body) {
  if (!body) {
    throw new ExportDownloadError(
      "EXPORT_FILE_BODY_MISSING",
      "Export file could not be retrieved.",
      502,
    );
  }
  if (typeof body.pipe === "function") return body;
  if (typeof Readable.fromWeb === "function") return Readable.fromWeb(body);
  return Readable.from(body);
}

function buildTimeoutError() {
  return new ExportDownloadError(
    "EXPORT_FILE_TIMEOUT",
    "Export file retrieval timed out.",
    504,
  );
}

export async function streamExportCsvDownload({
  command,
  exportJobId,
  shop,
  res,
  req = null,
  db = defaultDb,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const targetJobId = command?.exportJobId || exportJobId;
  const targetShop = command?.shop || shop;

  if (!res || typeof res.setHeader !== "function") {
    throw new ExportDownloadError("INTERNAL_ERROR", "Response object required.", 500);
  }
  if (typeof fetchImpl !== "function") {
    throw new ExportDownloadError("INTERNAL_ERROR", "Fetch implementation required.", 500);
  }

  const exportJob = await findDownloadableExport({ exportJobId: targetJobId, shop: targetShop, db });
  const abortController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    abortController.abort(buildTimeoutError());
  }, timeoutMs);

  const abortUpstream = () => abortController.abort();
  req?.once?.("aborted", abortUpstream);
  req?.once?.("close", abortUpstream);

  try {
    const upstream = await fetchImpl(exportJob.downloadUrl, {
      method: "GET",
      redirect: "follow",
      signal: abortController.signal,
    });

    if (!upstream?.ok) {
      throw new ExportDownloadError(
        "EXPORT_FILE_UPSTREAM_UNAVAILABLE",
        "Export file could not be retrieved.",
        mapUpstreamStatus(Number(upstream?.status || 0)),
        { upstreamStatus: Number(upstream?.status || 0) || null },
      );
    }

    const upstreamBody = responseBodyToNodeStream(upstream.body);
    const safeFilename = sanitizeAttachmentFilename(exportJob.filename);

    if (typeof res.set === "function") {
      res.set({
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeFilename}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store, max-age=0",
        Pragma: "no-cache",
        Expires: "0",
      });
    } else {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }

    await pipeline(upstreamBody, res);
  } catch (error) {
    if (timedOut || error?.name === "AbortError" || abortController.signal.aborted || req?.aborted || res?.destroyed) {
      if (timedOut) throw buildTimeoutError();
      throw new ExportDownloadError(
        "EXPORT_DOWNLOAD_ABORTED",
        "Export download was aborted.",
        499,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    req?.off?.("aborted", abortUpstream);
    req?.off?.("close", abortUpstream);
  }
}

export function logExportDownloadFailure(error, { exportJobId, shop }) {
  logger.error("Export CSV download failed", {
    exportId: exportJobId || null,
    shop: shop || null,
    statusCode: error?.statusCode || null,
    code: error?.code || "INTERNAL_ERROR",
    upstreamStatus: error?.details?.upstreamStatus || null,
  });
}
