import readline from "readline";
import { Readable } from "stream";
import { db } from "../../repositories/repositoryDb.js";
import { addbulkUndoJob } from "../../Jobs/Queues/bulkUndoJob.js";
import UndoEditService from "../productService/productBulkUndoService.js";
import { getSession } from "../../utils/sessionHandler.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import {
  BULK_UNDO_STATES,
  buildExecutionError,
  normalizeUndoState,
} from "../bulkEditExecutionStateService.js";
import {
  acquireOperationLease,
  assertOperationLeaseOwnership,
  buildLeaseOwnerId,
  heartbeatOperationLease,
  releaseOperationLease,
} from "../operationLeaseService.js";
import { refreshTargetSnapshotSetCounters } from "../../repositories/targetSnapshotSetRepository.js";

function createUndoError(code, message, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

const ALLOWED_WEBHOOK_STATUSES = new Set([
  "COMPLETED",
  "COMPLETED_WITH_ERRORS",
  "FAILED",
  "CANCELED",
  "CANCELLED",
  "EXPIRED",
  "RUNNING",
  "CREATED",
]);

function validateWebhookInput(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw createUndoError(
      "UNDO_INVALID_WEBHOOK_INPUT",
      "Webhook options must be an object",
      false
    );
  }

  const allowedKeys = new Set(["shop", "shopifyBulkOperationId", "status"]);
  for (const key of Object.keys(options)) {
    if (!allowedKeys.has(key)) {
      throw createUndoError(
        "UNDO_INVALID_WEBHOOK_INPUT",
        `Unknown input field: ${key}`,
        false
      );
    }
  }

  const { shop, shopifyBulkOperationId, status } = options;

  if (
    typeof shop !== "string" ||
    !shop.trim() ||
    shop.length > 255 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop)
  ) {
    throw createUndoError(
      "UNDO_INVALID_WEBHOOK_INPUT",
      "Invalid canonical shop domain format",
      false
    );
  }

  const idStr = String(shopifyBulkOperationId || "").trim();
  if (
    !idStr ||
    idStr.length > 100 ||
    !/^(gid:\/\/shopify\/BulkOperation\/)?[a-zA-Z0-9_-]+$/.test(idStr)
  ) {
    throw createUndoError(
      "UNDO_INVALID_WEBHOOK_INPUT",
      "Invalid Shopify bulk operation ID format",
      false
    );
  }

  if (status !== undefined && status !== null) {
    const statusStr = String(status).trim().toUpperCase();
    if (!statusStr || statusStr.length > 50 || !ALLOWED_WEBHOOK_STATUSES.has(statusStr)) {
      throw createUndoError(
        "UNDO_INVALID_WEBHOOK_INPUT",
        `Invalid status value: ${status}`,
        false
      );
    }
  }
}

function isPrivateOrLoopbackHost(hostname) {
  const host = hostname.toLowerCase();

  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "0000:0000:0000:0000:0000:0000:0000:0001"
  ) {
    return true;
  }

  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;

  if (/^fe80:/i.test(host)) return true;
  if (/^fc00:/i.test(host)) return true;
  if (/^fd00:/i.test(host)) return true;

  return false;
}

export function validateUndoResultUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string" || urlStr.length > 2048) {
    throw createUndoError(
      "UNDO_RESULT_URL_INVALID",
      "Result URL string length exceeds 2048 characters or is invalid",
      false
    );
  }

  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw createUndoError(
      "UNDO_RESULT_URL_INVALID",
      "Result URL is not a valid parseable URL",
      false
    );
  }

  if (parsed.protocol !== "https:") {
    throw createUndoError(
      "UNDO_RESULT_URL_INVALID",
      "Result URL protocol must be HTTPS",
      false
    );
  }

  if (parsed.username || parsed.password) {
    throw createUndoError(
      "UNDO_RESULT_URL_INVALID",
      "Result URL must not contain embedded user credentials",
      false
    );
  }

  const hostname = parsed.hostname.toLowerCase();

  if (isPrivateOrLoopbackHost(hostname)) {
    throw createUndoError(
      "UNDO_RESULT_URL_INVALID",
      "Result URL host refers to a private, loopback, or link-local address",
      false
    );
  }

  const isShopifyHost =
    hostname.endsWith(".myshopify.com") ||
    hostname.endsWith(".shopifycdn.com") ||
    hostname.endsWith(".amazonaws.com") ||
    hostname.endsWith(".googleapis.com") ||
    hostname === "shopify-tier-1-files.s3.amazonaws.com";

  if (!isShopifyHost) {
    throw createUndoError(
      "UNDO_RESULT_URL_INVALID",
      `Result URL host ${hostname} is not an allowlisted Shopify storage domain`,
      false
    );
  }

  return parsed.href;
}

function mergeBatch(existingBatch, patch) {
  return {
    ...(existingBatch && typeof existingBatch === "object"
      ? existingBatch
      : {}),
    ...patch,
  };
}

function calculateDurationMs(startedAt, completedAt = new Date()) {
  const start = new Date(startedAt || completedAt).getTime();
  const end = new Date(completedAt).getTime();
  return Math.max(end - start, 0);
}

function extractBulkRowErrors(row = {}) {
  const payload = row?.data && typeof row.data === "object" ? row.data : row;
  const errors =
    payload?.productSet?.userErrors ||
    payload?.productSet?.productSetOperation?.userErrors ||
    payload?.userErrors ||
    row?.userErrors ||
    [];
  return Array.isArray(errors) ? errors : [];
}

function sanitizeItemError(error) {
  const rawCode = error?.code || error?.field || "UNKNOWN_ERROR";
  const code = String(rawCode).slice(0, 100);

  let field = "";
  if (Array.isArray(error?.field)) {
    field = error.field.join(".").slice(0, 100);
  } else if (error?.field) {
    field = String(error.field).slice(0, 100);
  }

  const rawMessage = error?.message || error?.userErrorMessage || "Shopify item error";
  const message = String(rawMessage).slice(0, 250);

  return { code, field, message };
}

async function inspectUndoResultJsonl(resultUrl, onProgressHeartbeat) {
  const MAX_RESPONSE_BYTES = 100 * 1024 * 1024;
  const MAX_ROWS = 500_000;
  const MAX_LINE_BYTES = 1 * 1024 * 1024;
  const MAX_REDIRECTS = 3;

  let currentUrl = validateUndoResultUrl(resultUrl);
  let response = null;
  let redirects = 0;

  while (redirects <= MAX_REDIRECTS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000);

    try {
      response = await fetch(currentUrl, {
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === "AbortError") {
        throw createUndoError(
          "UNDO_RESULT_DOWNLOAD_TIMEOUT",
          "JSONL download timed out after 60 seconds",
          true
        );
      }
      throw createUndoError(
        "UNDO_RESULT_DOWNLOAD_FAILED",
        `JSONL download fetch failed: ${err.message}`,
        true
      );
    } finally {
      clearTimeout(timeoutId);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      redirects += 1;
      if (redirects > MAX_REDIRECTS) {
        throw createUndoError(
          "UNDO_RESULT_REDIRECT_LIMIT_EXCEEDED",
          "Too many redirects while fetching JSONL result",
          false
        );
      }
      const location = response.headers.get("location");
      if (!location) {
        throw createUndoError(
          "UNDO_RESULT_URL_INVALID",
          "Redirect response missing Location header",
          false
        );
      }
      const redirectTarget = new URL(location, currentUrl).href;
      currentUrl = validateUndoResultUrl(redirectTarget);
      continue;
    }

    if (!response.ok) {
      throw createUndoError(
        `UNDO_RESULT_DOWNLOAD_FAILED_${response.status}`,
        `JSONL download HTTP failure with status ${response.status}`,
        response.status >= 500
      );
    }

    const contentType = response.headers.get("content-type");
    if (contentType) {
      const lower = contentType.toLowerCase();
      const isValidContentType =
        lower.includes("text/") ||
        lower.includes("application/") ||
        lower.includes("octet-stream");
      if (!isValidContentType) {
        throw createUndoError(
          "UNDO_RESULT_INVALID_CONTENT_TYPE",
          `Unexpected Content-Type header: ${contentType}`,
          false
        );
      }
    }
    break;
  }

  if (!response || !response.body) {
    throw createUndoError(
      "UNDO_RESULT_DOWNLOAD_FAILED",
      "Response body stream unavailable",
      true
    );
  }

  const nodeStream = Readable.fromWeb(response.body);
  const rl = readline.createInterface({
    input: nodeStream,
    crlfDelay: Infinity,
  });

  let rowCount = 0;
  let malformedCount = 0;
  let itemErrorCount = 0;
  let totalBytesRead = 0;
  const sampledItemErrors = [];

  try {
    for await (const line of rl) {
      const lineByteLength = Buffer.byteLength(line, "utf8");
      totalBytesRead += lineByteLength;

      if (totalBytesRead > MAX_RESPONSE_BYTES) {
        rl.close();
        nodeStream.destroy();
        throw createUndoError(
          "UNDO_RESULT_SIZE_EXCEEDED",
          `JSONL download response exceeded max size of ${MAX_RESPONSE_BYTES} bytes`,
          false
        );
      }

      if (lineByteLength > MAX_LINE_BYTES) {
        rl.close();
        nodeStream.destroy();
        throw createUndoError(
          "UNDO_RESULT_LINE_TOO_LONG",
          `JSONL line length exceeded max size of ${MAX_LINE_BYTES} bytes`,
          false
        );
      }

      const trimmed = line.trim();
      if (!trimmed) continue;

      rowCount += 1;
      if (rowCount > MAX_ROWS) {
        rl.close();
        nodeStream.destroy();
        throw createUndoError(
          "UNDO_RESULT_ROW_LIMIT_EXCEEDED",
          `JSONL row count exceeded max limit of ${MAX_ROWS} rows`,
          false
        );
      }

      if (rowCount % 5000 === 0 && typeof onProgressHeartbeat === "function") {
        await onProgressHeartbeat();
      }

      try {
        const parsed = JSON.parse(trimmed);
        const rowErrors = extractBulkRowErrors(parsed);
        for (const rawErr of rowErrors) {
          itemErrorCount += 1;
          if (sampledItemErrors.length < 200) {
            sampledItemErrors.push(sanitizeItemError(rawErr));
          }
        }
      } catch {
        malformedCount += 1;
      }
    }
  } catch (err) {
    nodeStream.destroy();
    if (err.code && String(err.code).startsWith("UNDO_")) {
      throw err;
    }
    throw createUndoError(
      "UNDO_RESULT_PARSE_FAILED",
      `Error parsing JSONL result stream: ${err.message}`,
      false
    );
  }

  return {
    rowCount,
    malformedCount,
    itemErrorCount,
    failureCount: itemErrorCount + malformedCount,
    itemErrors: sampledItemErrors,
  };
}

async function resolveUndoResultUrl({ session, shopifyBulkOperationId }) {
  const client = new UndoEditService(session).client;
  const response = await client.request(
    `#graphql
      query UndoBulkResultUrl($id: ID!) {
        node(id: $id) {
          ... on BulkOperation { id status url partialDataUrl }
        }
      }
    `,
    { variables: { id: String(shopifyBulkOperationId) } }
  );
  const operation = response?.data?.node || response?.body?.data?.node || null;
  const resultUrl = operation?.url || operation?.partialDataUrl || null;
  if (!resultUrl) {
    throw createUndoError(
      "UNDO_RESULT_URL_MISSING",
      "Undo result URL is unavailable from Shopify BulkOperation node",
      true
    );
  }
  return validateUndoResultUrl(resultUrl);
}

async function renewLease({ shop, resourceId, ownerId }) {
  const renewed = await heartbeatOperationLease({
    shop,
    namespace: "BULK_UNDO_RESULT_INGEST",
    resourceId: String(resourceId),
    ownerId,
  });
  if (!renewed) {
    throw createUndoError(
      "UNDO_RESULT_INGEST_LEASE_LOST",
      "Undo result ingest lease ownership lost or expired during execution",
      false
    );
  }
}

async function loadTrustedUndoReplay({ history, undo, shop }) {
  const MAX_CHUNKS = 1000;
  const MAX_TARGETS_PER_CHUNK = 5000;
  const MAX_TOTAL_IDENTITIES = 250_000;
  const MAX_IDENTITY_LENGTH = 255;
  const BATCH_SIZE = 1000;

  const chunks = undo?.undoOperationId
    ? await db.undoOperationConflictChunk.findMany({
        where: {
          shop,
          undoOperationId: undo.undoOperationId,
          chunkType: "SAFE_IDENTITIES",
        },
        orderBy: { chunkIndex: "asc" },
        take: MAX_CHUNKS + 1,
        select: { payload: true },
      })
    : [];

  if (chunks.length > MAX_CHUNKS) {
    throw createUndoError(
      "UNDO_TARGET_LIMIT_EXCEEDED",
      `Safe identities chunk count exceeds maximum limit of ${MAX_CHUNKS}`,
      false
    );
  }

  const uniqueIdentitiesSet = new Set();

  for (const chunk of chunks) {
    if (!chunk?.payload || typeof chunk.payload !== "object") {
      throw createUndoError(
        "UNDO_PAYLOAD_MALFORMED",
        "Chunk payload must be an object",
        false
      );
    }
    const rawIdentities = chunk.payload.targetIdentities;
    if (!Array.isArray(rawIdentities)) {
      throw createUndoError(
        "UNDO_PAYLOAD_MALFORMED",
        "Chunk payload targetIdentities must be an array",
        false
      );
    }
    if (rawIdentities.length > MAX_TARGETS_PER_CHUNK) {
      throw createUndoError(
        "UNDO_TARGET_LIMIT_EXCEEDED",
        `Chunk contains ${rawIdentities.length} target identities exceeding chunk limit of ${MAX_TARGETS_PER_CHUNK}`,
        false
      );
    }

    for (const item of rawIdentities) {
      if (typeof item !== "string" && typeof item !== "number") {
        throw createUndoError(
          "UNDO_PAYLOAD_MALFORMED",
          "Target identity must be a string or number",
          false
        );
      }
      const strItem = String(item).trim();
      if (!strItem || strItem.length > MAX_IDENTITY_LENGTH) {
        throw createUndoError(
          "UNDO_PAYLOAD_MALFORMED",
          `Target identity length exceeds limit of ${MAX_IDENTITY_LENGTH}`,
          false
        );
      }
      uniqueIdentitiesSet.add(strItem);
      if (uniqueIdentitiesSet.size > MAX_TOTAL_IDENTITIES) {
        throw createUndoError(
          "UNDO_TARGET_LIMIT_EXCEEDED",
          `Total unique target identities exceed maximum limit of ${MAX_TOTAL_IDENTITIES}`,
          false
        );
      }
    }
  }

  const targetIdentities = Array.from(uniqueIdentitiesSet);
  if (!targetIdentities.length) {
    throw createUndoError(
      "UNDO_SAFE_TARGETS_MISSING",
      "No safe target identities found for undo replay",
      false
    );
  }

  const snapshotSetId = String(
    history?.batch?.targetSnapshotRef?.snapshotSetId || ""
  ).trim();
  if (!snapshotSetId) {
    throw createUndoError(
      "UNDO_SNAPSHOT_SET_MISSING",
      "Target snapshot set reference missing from edit history",
      false
    );
  }

  const changes = [];
  for (let i = 0; i < targetIdentities.length; i += BATCH_SIZE) {
    const slice = targetIdentities.slice(i, i + BATCH_SIZE);
    const batchChanges = await db.changeRecord.findMany({
      where: {
        shop,
        editHistoryId: history.id,
        targetIdentity: { in: slice },
      },
    });
    changes.push(...batchChanges);
  }

  const snapshots = [];
  for (let i = 0; i < targetIdentities.length; i += BATCH_SIZE) {
    const slice = targetIdentities.slice(i, i + BATCH_SIZE);
    const batchSnapshots = await db.targetSnapshotItem.findMany({
      where: { shop, snapshotSetId, targetKey: { in: slice } },
      select: {
        id: true,
        targetKey: true,
        fieldPath: true,
        beforeValues: true,
        plannedMutation: true,
      },
    });
    snapshots.push(...batchSnapshots);
  }

  const snapshotByIdentity = new Map(
    snapshots.map((snapshot) => [
      `${String(snapshot.targetKey)}\u001f${String(snapshot.fieldPath)}`,
      snapshot,
    ])
  );

  return { changes, snapshots, snapshotByIdentity, snapshotSetId };
}

async function applyVerifiedUndoToMirror({ shop, replayProducts }) {
  const store = await db.store.findUnique({
    where: { shopUrl: shop },
    select: { currentProductMirrorBatchId: true },
  });
  const mirrorBatchId = store?.currentProductMirrorBatchId;
  if (!mirrorBatchId) {
    throw createUndoError(
      "UNDO_ACTIVE_MIRROR_BATCH_MISSING",
      "Active product mirror batch missing for shop",
      false
    );
  }

  const variantFields = new Set([
    "title",
    "sku",
    "barcode",
    "price",
    "compareAtPrice",
    "inventoryQuantity",
    "inventoryPolicy",
    "taxable",
    "taxCode",
    "weight",
    "weightUnit",
  ]);
  const productFields = new Set([
    "title",
    "handle",
    "vendor",
    "productType",
    "status",
    "tags",
    "templateSuffix",
    "descriptionHtml",
  ]);

  for (const replay of replayProducts) {
    const productData = {};
    for (const change of replay.productFieldChanges || []) {
      const field =
        change?.field === "description" ? "descriptionHtml" : change?.field;
      if (productFields.has(field)) {
        productData[field] = change.revertValue ?? change.oldValue;
      }
    }
    if (Object.keys(productData).length) {
      await db.product.updateMany({
        where: { shop, id: replay.productId, mirrorBatchId },
        data: productData,
      });
    }
    for (const variant of replay.variantFieldChanges || []) {
      const variantData = {};
      for (const change of variant.changes || []) {
        const field =
          change?.field === "inventory" ? "inventoryQuantity" : change?.field;
        if (variantFields.has(field)) {
          variantData[field] = change.revertValue ?? change.oldValue;
        }
      }
      if (Object.keys(variantData).length) {
        await db.variant.updateMany({
          where: { shop, id: variant.variantId, mirrorBatchId },
          data: variantData,
        });
      }
    }
  }
}

async function markUndoExecutionFailed({
  history,
  undo,
  shop,
  code,
  message,
  details = {},
}) {
  const completedAt = new Date();
  const moved = await db.editHistory.updateMany({
    where: { id: history.id, shop, updatedAt: history.updatedAt },
    data: {
      shopifyBulkOperationId: null,
      processingChunkId: null,
      undo: {
        ...undo,
        outcomeStatus: "failed",
        executionState: BULK_UNDO_STATES.FAILED,
        completedAt,
        shopifyBulkOperationId: null,
        durationMs: calculateDurationMs(
          undo.startedAt || history.startedAt,
          completedAt
        ),
        error: buildExecutionError({
          code,
          stage: "webhook_ingest",
          message,
          retryable: false,
          details,
        }),
      },
    },
  });
  if (moved.count !== 1) {
    throw createUndoError(
      "UNDO_TERMINAL_FAILURE_TRANSITION_REJECTED",
      "Terminal failure transition rejected because history row state changed",
      false
    );
  }
  if (undo?.undoOperationId) {
    await db.undoOperation.updateMany({
      where: { id: undo.undoOperationId, shop },
      data: {
        outcomeStatus: "failed",
        executionState: "failed",
        shopifyBulkOperationId: null,
        processedCount: Number(undo.processedCount || 0),
        failureCode: String(code || "UNDO_FAILED").toUpperCase(),
        failureMessage: message,
        completedAt,
      },
    });
  }
}

export class UndoResultIngestionService {
  async ingestUndoBulkOperationWebhook(options = {}) {
    validateWebhookInput(options);
    const { shop, shopifyBulkOperationId, status } = options;

    const leaseOwnerId = buildLeaseOwnerId("bulk-undo-result-ingest");
    const lease = await acquireOperationLease({
      shop,
      namespace: "BULK_UNDO_RESULT_INGEST",
      resourceId: String(shopifyBulkOperationId),
      ownerId: leaseOwnerId,
    });
    if (!lease?.acquired) {
      throw createUndoError(
        "UNDO_RESULT_INGEST_LEASE_CONFLICT",
        "Could not acquire operation lease for bulk undo result ingest",
        true
      );
    }

    try {
      await assertOperationLeaseOwnership({
        shop,
        namespace: "BULK_UNDO_RESULT_INGEST",
        resourceId: String(shopifyBulkOperationId),
        ownerId: leaseOwnerId,
      });

      const normalizedStatus = String(status || "").toUpperCase();
      const history = await db.editHistory.findFirst({
        where: {
          shop,
          shopifyBulkOperationId: String(shopifyBulkOperationId),
        },
        select: {
          id: true,
          shop: true,
          batch: true,
          undo: true,
          startedAt: true,
          executionIdentity: true,
          updatedAt: true,
        },
      });

      if (!history) {
        return { skipped: true, reason: "UNDO_HISTORY_NOT_FOUND" };
      }

      const undo = normalizeUndoState(history.undo, {});
      const undoOperationId =
        String(undo?.undoOperationId || "").trim() || null;
      const batch =
        history.batch && typeof history.batch === "object" ? history.batch : {};
      const allowedWebhookTerminalStates = [
        BULK_UNDO_STATES.AWAITING_SHOPIFY,
        BULK_UNDO_STATES.FINALIZING,
        BULK_UNDO_STATES.RETRYABLE_FAILURE,
      ];

      if (
        !allowedWebhookTerminalStates.includes(String(undo.executionState || "")) ||
        String(undo.shopifyBulkOperationId || "") !== String(shopifyBulkOperationId)
      ) {
        return {
          skipped: true,
          reason: "UNDO_BULK_OPERATION_STALE",
          historyId: history.id,
        };
      }

      if (
        ["FAILED", "CANCELED", "CANCELLED", "EXPIRED"].includes(
          normalizedStatus
        )
      ) {
        await assertOperationLeaseOwnership({
          shop,
          namespace: "BULK_UNDO_RESULT_INGEST",
          resourceId: String(shopifyBulkOperationId),
          ownerId: leaseOwnerId,
        });
        const movedFailed = await db.editHistory.updateMany({
          where: {
            id: history.id,
            shop,
            updatedAt: history.updatedAt,
          },
          data: {
            shopifyBulkOperationId: null,
            processingChunkId: null,
            undo: {
              ...undo,
              outcomeStatus: "failed",
              executionState: BULK_UNDO_STATES.FAILED,
              completedAt: new Date(),
              shopifyBulkOperationId: null,
              durationMs: calculateDurationMs(
                undo.startedAt || history.startedAt,
                new Date()
              ),
              error: buildExecutionError({
                code: "undo_bulk_failure",
                stage: "webhook_ingest",
                message: `Undo bulk operation ${normalizedStatus}`,
                retryable: false,
                details: { shopifyBulkOperationId },
              }),
            },
          },
        });
        if (movedFailed.count !== 1) {
          throw createUndoError(
            "UNDO_TERMINAL_FAILURE_TRANSITION_REJECTED",
            "Terminal failure transition rejected during status handling",
            false
          );
        }
        if (undoOperationId) {
          await db.undoOperation.updateMany({
            where: { id: undoOperationId, shop },
            data: {
              outcomeStatus: "failed",
              executionState: "failed",
              shopifyBulkOperationId: null,
              processedCount: Number(undo.processedCount || 0),
              failedCount: Math.max(
                Number(undo?.eligibility?.eligibleCount || 0) -
                  Number(undo.processedCount || 0),
                1
              ),
              failureCode: "UNDO_SHOPIFY_BULK_OPERATION_FAILED",
              failureMessage: `Shopify undo operation ${normalizedStatus}`,
              completedAt: new Date(),
            },
          });
        }
        return { success: true, failed: true, historyId: history.id };
      }

      if (!["COMPLETED", "COMPLETED_WITH_ERRORS"].includes(normalizedStatus)) {
        return {
          skipped: true,
          reason: "UNDO_BULK_OPERATION_NOT_TERMINAL",
          historyId: history.id,
          status: normalizedStatus || "UNKNOWN",
        };
      }

      const session = await getSession(shop);
      if (!session?.shop || session.shop !== shop) {
        throw createUndoError(
          "UNDO_RESULT_SESSION_NOT_AVAILABLE",
          `Authenticated shop session unavailable for shop ${shop}`,
          true
        );
      }

      await renewLease({ shop, resourceId: shopifyBulkOperationId, ownerId: leaseOwnerId });

      const authoritativeResultUrl = await resolveUndoResultUrl({
        session,
        shopifyBulkOperationId,
      });

      await renewLease({ shop, resourceId: shopifyBulkOperationId, ownerId: leaseOwnerId });

      const trustedReplay = await loadTrustedUndoReplay({
        history,
        undo,
        shop,
      });

      await renewLease({ shop, resourceId: shopifyBulkOperationId, ownerId: leaseOwnerId });

      const resultSummary = await inspectUndoResultJsonl(
        authoritativeResultUrl,
        () => renewLease({ shop, resourceId: shopifyBulkOperationId, ownerId: leaseOwnerId })
      );

      await renewLease({ shop, resourceId: shopifyBulkOperationId, ownerId: leaseOwnerId });

      if (resultSummary.failureCount > 0) {
        await assertOperationLeaseOwnership({
          shop,
          namespace: "BULK_UNDO_RESULT_INGEST",
          resourceId: String(shopifyBulkOperationId),
          ownerId: leaseOwnerId,
        });
        await db.$transaction(async (tx) => {
          if (undoOperationId) {
            await tx.undoItem.updateMany({
              where: { shop, undoOperationId, outcome: "SUBMITTED" },
              data: {
                outcome: "FAILED",
                failureCode: "SHOPIFY_UNDO_ITEM_FAILURE",
                failureMessage: "Shopify rejected the undo mutation row",
              },
            });
          }
          await tx.targetSnapshotItem.updateMany({
            where: {
              shop,
              id: { in: trustedReplay.snapshots.map((snapshot) => snapshot.id) },
              undoStatus: { in: ["PENDING", "SUBMITTED"] },
            },
            data: {
              undoStatus: "FAILED",
              undoErrorCode: "SHOPIFY_UNDO_ITEM_FAILURE",
              undoErrorMessage: "Shopify rejected the undo mutation row",
              undoMutation: {
                version: 1,
                status: "failed",
                verified: false,
                itemErrors: resultSummary.itemErrors,
              },
            },
          });
          await refreshTargetSnapshotSetCounters({
            shop,
            snapshotSetId: trustedReplay.snapshotSetId,
            db: tx,
          });
        });
        await markUndoExecutionFailed({
          history,
          undo,
          shop,
          code: "undo_shopify_item_failure",
          message: "Shopify rejected one or more undo mutation rows",
          details: {
            shopifyBulkOperationId,
            rowCount: resultSummary.rowCount,
            malformedCount: resultSummary.malformedCount,
            itemErrors: resultSummary.itemErrors,
          },
        });
        return {
          success: false,
          failed: true,
          reason: "UNDO_SHOPIFY_ITEM_FAILURE",
          historyId: history.id,
        };
      }

      const undoService = new UndoEditService(session);
      const reconstructedReplayProducts = undoService.buildUndoReplayRecords(
        trustedReplay.changes,
        trustedReplay.snapshotByIdentity
      );
      const immutableUndoItems = undoOperationId
        ? await db.undoItem.findMany({
            where: {
              shop,
              undoOperationId,
              targetIdentity: {
                in: trustedReplay.changes
                  .map((change) => change.targetIdentity)
                  .filter(Boolean),
              },
              outcome: "SUBMITTED",
            },
          })
        : [];
      if (!immutableUndoItems.length) {
        throw createUndoError(
          "UNDO_IMMUTABLE_ITEMS_REQUIRED",
          "Trusted immutable undo items are required for verification",
          false
        );
      }
      const replayProducts = undoService.hydrateReplayRecordsFromUndoItems(
        reconstructedReplayProducts,
        immutableUndoItems
      );

      await renewLease({ shop, resourceId: shopifyBulkOperationId, ownerId: leaseOwnerId });

      const verification = await undoService.verifyUndoRestored(
        replayProducts,
        immutableUndoItems
      );

      await renewLease({ shop, resourceId: shopifyBulkOperationId, ownerId: leaseOwnerId });

      if (!verification.verified) {
        await assertOperationLeaseOwnership({
          shop,
          namespace: "BULK_UNDO_RESULT_INGEST",
          resourceId: String(shopifyBulkOperationId),
          ownerId: leaseOwnerId,
        });
        await db.$transaction(async (tx) => {
          await tx.undoItem.updateMany({
            where: {
              shop,
              undoOperationId,
              id: {
                in: immutableUndoItems.map((item) => item.id),
              },
              outcome: "SUBMITTED",
            },
            data: {
              outcome: "FAILED",
              failureCode: "UNDO_VERIFICATION_FAILED",
              failureMessage:
                "Shopify state did not match the trusted before-value hash",
            },
          });
          for (const snapshot of trustedReplay.snapshots) {
            await tx.targetSnapshotItem.updateMany({
              where: {
                id: snapshot.id,
                shop,
                undoStatus: { in: ["PENDING", "SUBMITTED"] },
              },
              data: {
                undoStatus: "FAILED",
                undoErrorCode: "UNDO_VERIFICATION_FAILED",
                undoErrorMessage:
                  "Shopify state did not match the trusted undo snapshot",
                undoMutation: {
                  version: 1,
                  status: "verification_failed",
                  verified: false,
                  verifiedAt: verification.verifiedAt,
                  fields: verification.evidence.filter(
                    (entry) => entry.targetIdentity === snapshot.targetKey
                  ),
                },
              },
            });
          }
          await refreshTargetSnapshotSetCounters({
            shop,
            snapshotSetId: trustedReplay.snapshotSetId,
            db: tx,
          });
        });
        await markUndoExecutionFailed({
          history,
          undo,
          shop,
          code: "undo_verification_failed",
          message: "Shopify state did not match the trusted undo snapshot",
          details: {
            shopifyBulkOperationId,
            failures: verification.failures.slice(0, 200),
          },
        });
        return {
          success: false,
          failed: true,
          reason: "UNDO_VERIFICATION_FAILED",
          historyId: history.id,
        };
      }

      await applyVerifiedUndoToMirror({ shop, replayProducts });

      await renewLease({ shop, resourceId: shopifyBulkOperationId, ownerId: leaseOwnerId });

      await db.$transaction(async (tx) => {
        await tx.undoItem.updateMany({
          where: {
            shop,
            undoOperationId,
            id: { in: immutableUndoItems.map((item) => item.id) },
            outcome: "SUBMITTED",
          },
          data: {
            outcome: "RESTORED",
            restoredAt: new Date(verification.verifiedAt),
            failureCode: null,
            failureMessage: null,
          },
        });
        for (const snapshot of trustedReplay.snapshots) {
          await tx.targetSnapshotItem.updateMany({
            where: {
              id: snapshot.id,
              shop,
              undoStatus: { in: ["PENDING", "SUBMITTED"] },
            },
            data: {
              undoStatus: "SUCCEEDED",
              undoErrorCode: null,
              undoErrorMessage: null,
              undoneAt: new Date(verification.verifiedAt),
              undoMutation: {
                version: 1,
                status: "succeeded",
                verified: true,
                verifiedAt: verification.verifiedAt,
                fields: verification.evidence.filter(
                  (entry) => entry.targetIdentity === snapshot.targetKey
                ),
              },
            },
          });
        }
        await refreshTargetSnapshotSetCounters({
          shop,
          snapshotSetId: trustedReplay.snapshotSetId,
          db: tx,
        });
      });

      const batchTargetCount = Number(batch.currentBatchTargetCount || 0);
      const nextProcessedCount =
        Number(undo.processedCount || 0) + batchTargetCount;
      const hasMore = Boolean(batch.hasMore);

      if (hasMore) {
        await assertOperationLeaseOwnership({
          shop,
          namespace: "BULK_UNDO_RESULT_INGEST",
          resourceId: String(shopifyBulkOperationId),
          ownerId: leaseOwnerId,
        });
        const movedQueued = await db.editHistory.updateMany({
          where: {
            id: history.id,
            shop,
            updatedAt: history.updatedAt,
          },
          data: {
            shopifyBulkOperationId: null,
            processingChunkId: null,
            batch: mergeBatch(batch, {
              currentBatchId: null,
              currentBatchCount: 0,
              currentBatchTargetCount: 0,
              lastUndoFinalizedAt: new Date().toISOString(),
            }),
            undo: {
              ...undo,
              processedCount: nextProcessedCount,
              executionState: BULK_UNDO_STATES.QUEUED,
              outcomeStatus: "pending",
              shopifyBulkOperationId: null,
              durationMs: calculateDurationMs(
                undo.startedAt || history.startedAt
              ),
            },
          },
        });
        if (movedQueued.count !== 1) {
          throw createUndoError(
            "UNDO_CONTINUATION_TRANSITION_REJECTED",
            "Continuation transition rejected during undo queuing",
            false
          );
        }
        if (undoOperationId) {
          await db.undoOperation.updateMany({
            where: { id: undoOperationId, shop },
            data: {
              outcomeStatus: "pending",
              executionState: "queued",
              shopifyBulkOperationId: null,
              processedCount: nextProcessedCount,
            },
          });
        }

        await addbulkUndoJob({
          historyId: history.id,
          shop,
          source: "undo_webhook_continuation",
          executionId:
            undo.executionIdentity || history.executionIdentity || history.id,
        });

        return { success: true, continued: true, historyId: history.id };
      }

      const completedAt = new Date();
      const conflictedCount = Number(undo?.conflictReport?.conflictCount || 0);
      const completedWithErrors = normalizedStatus === "COMPLETED_WITH_ERRORS";
      const isPartial = conflictedCount > 0 || completedWithErrors;

      await assertOperationLeaseOwnership({
        shop,
        namespace: "BULK_UNDO_RESULT_INGEST",
        resourceId: String(shopifyBulkOperationId),
        ownerId: leaseOwnerId,
      });

      const movedCompleted = await db.editHistory.updateMany({
        where: {
          id: history.id,
          shop,
          updatedAt: history.updatedAt,
        },
        data: {
          shopifyBulkOperationId: null,
          processingChunkId: null,
          batch: mergeBatch(batch, {
            hasMore: false,
            currentBatchId: null,
            currentBatchCount: 0,
            currentBatchTargetCount: 0,
            lastUndoFinalizedAt: completedAt.toISOString(),
          }),
          undo: {
            ...undo,
            outcomeStatus: isPartial ? "partial" : "completed",
            executionState: isPartial
              ? BULK_UNDO_STATES.PARTIAL
              : BULK_UNDO_STATES.COMPLETED,
            allowed: false,
            completedAt,
            processedCount: nextProcessedCount,
            durationMs: calculateDurationMs(
              undo.startedAt || history.startedAt,
              completedAt
            ),
            error: null,
            verification: {
              status: "verified",
              verified: true,
              verifiedAt: verification.verifiedAt,
              evidenceCount: verification.evidence.length,
            },
            shopifyBulkOperationId: null,
            lastChangeRecordId: null,
          },
        },
      });

      if (movedCompleted.count !== 1) {
        throw createUndoError(
          "UNDO_COMPLETION_TRANSITION_REJECTED",
          "Completion transition rejected during history update",
          false
        );
      }

      if (undoOperationId) {
        await db.undoOperation.updateMany({
          where: { id: undoOperationId, shop },
          data: {
            outcomeStatus: isPartial ? "partial" : "completed",
            executionState: isPartial ? "partially_completed" : "completed",
            shopifyBulkOperationId: null,
            processedCount: nextProcessedCount,
            restoredCount: nextProcessedCount,
            conflictedCount,
            failedCount: completedWithErrors ? 1 : 0,
            failureCode: null,
            failureMessage: null,
            completedAt,
          },
        });
      }

      await clearKeyCaches(`${shop}:fetchHistories`).catch(() => {});
      await clearKeyCaches(`${shop}:historyDetails:${history.id}`).catch(
        () => {}
      );
      await clearKeyCaches(`${shop}:historyChanges:${history.id}`).catch(
        () => {}
      );

      return { success: true, continued: false, historyId: history.id };
    } finally {
      await releaseOperationLease({
        shop,
        namespace: "BULK_UNDO_RESULT_INGEST",
        resourceId: String(shopifyBulkOperationId),
        ownerId: leaseOwnerId,
      }).catch(() => {});
    }
  }
}
