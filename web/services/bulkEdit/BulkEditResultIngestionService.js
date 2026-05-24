import readline from "node:readline";
import { Readable } from "node:stream";
import { prisma } from "../../config/database.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../operationLifecycleStateMachine.js";

function normalizeTargetIdentity(row) {
  return String(
    row?.targetIdentity
      || row?.target?.identity
      || row?.id
      || row?.product?.id
      || row?.productSet?.product?.id
      || "",
  ).trim() || null;
}

function extractRowResult(row = {}) {
  const userErrors =
    row?.userErrors
    || row?.productSet?.userErrors
    || row?.product?.userErrors
    || [];
  const normalizedErrors = Array.isArray(userErrors) ? userErrors : [];

  const targetIdentity = normalizeTargetIdentity(row);
  const productIdRaw = row?.productId || row?.id || row?.product?.id || null;
  const variantIdRaw = row?.variantId || row?.variant?.id || null;

  return {
    targetIdentity,
    productId: productIdRaw ? String(productIdRaw) : null,
    variantId: variantIdRaw ? String(variantIdRaw) : null,
    status: normalizedErrors.length > 0 ? "FAILED" : "SUCCESS",
    shopifyUserErrors: normalizedErrors,
  };
}

async function processJsonlLines(url, onRow) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download Shopify result JSONL: ${response.status}`);
  }
  const body = response.body;
  if (!body) {
    throw new Error("Shopify result body is empty");
  }

  const nodeStream = Readable.fromWeb(body);
  const rl = readline.createInterface({ input: nodeStream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      // eslint-disable-next-line no-await-in-loop
      await onRow(parsed);
    } catch {
      // ignore malformed lines and continue ingesting
    }
  }
}

function mergeBatch(existingBatch, patch) {
  return {
    ...(existingBatch && typeof existingBatch === "object" ? existingBatch : {}),
    ...patch,
  };
}

export class BulkEditResultIngestionService {
  async ingestCompletedBulkOperation({
    shop,
    historyId,
    executionId = null,
    bulkOperationId,
    resultUrl,
    attempt = 1,
  }) {
    const history = await prisma.editHistory.findUnique({
      where: { id: historyId },
      select: {
        id: true,
        shop: true,
        executionIdentity: true,
        batch: true,
        bulkOperationId: true,
        processingBatchId: true,
      },
    });

    if (!history) throw new Error("Edit history not found");
    if (history.shop !== shop) throw new Error("SHOP_MISMATCH");
    if (executionId && history.executionIdentity && executionId !== history.executionIdentity) {
      throw new Error("STALE_EXECUTION_JOB");
    }

    const submittedBulkOperationId = history.batch?.shopifyBulkOperation?.id || history.bulkOperationId;
    if (!submittedBulkOperationId || String(submittedBulkOperationId) !== String(bulkOperationId)) {
      throw new Error("SHOPIFY_BULK_OPERATION_MISMATCH");
    }

    const batchId =
      history.batch?.submittedBatchId
      || history.batch?.shopifyBulkOperation?.batchId
      || history.processingBatchId
      || null;

    const ingestingUpdate = await prisma.editHistory.updateMany({
      where: { id: historyId, shop },
      data: {
        executionState: OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
        executionStateNormalized: normalizeEditHistoryExecutionState(
          OPERATION_LIFECYCLE_STATES.INGESTING_RESULTS,
        ),
      },
    });
    if (ingestingUpdate.count !== 1) {
      throw new Error("EDIT_HISTORY_UPDATE_FAILED_SET_INGESTING");
    }

    let successCount = 0;
    let failureCount = 0;
    let rowCount = 0;
    let unmappedRowCount = 0;
    const ingestionRunId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const pendingUpdates = [];
    const FLUSH_SIZE = 500;

    const flushPending = async () => {
      if (!pendingUpdates.length) return;
      const updates = pendingUpdates.splice(0, pendingUpdates.length);
      const txOps = updates.map((item) => prisma.changeRecord.updateMany({
        where: {
          editHistoryId: historyId,
          shop,
          ...(batchId ? { batchId } : {}),
          targetIdentity: item.targetIdentity,
          status: { in: ["pending", "PENDING", "failed", "FAILED"] },
        },
        data: {
          status: item.status,
          failureCode: item.status === "FAILED" ? "SHOPIFY_USER_ERRORS" : null,
          failureMessage: item.status === "FAILED"
            ? JSON.stringify(item.shopifyUserErrors || [])
            : null,
          options: {
            attempt,
            shopifyUserErrors: item.shopifyUserErrors || [],
          },
        },
      }));
      const results = await prisma.$transaction(txOps);
      for (let i = 0; i < results.length; i += 1) {
        const count = Number(results[i]?.count || 0);
        const row = updates[i];
        if (!count) {
          unmappedRowCount += 1;
          continue;
        }
        if (row.status === "SUCCESS") successCount += count;
        else failureCount += count;
      }
    };

    await processJsonlLines(resultUrl, async (row) => {
      rowCount += 1;
      const item = extractRowResult(row);
      if (!item.targetIdentity) {
        unmappedRowCount += 1;
        return;
      }

      pendingUpdates.push({
        targetIdentity: item.targetIdentity,
        status: item.status === "SUCCESS" ? "SUCCESS" : "FAILED",
        shopifyUserErrors: item.shopifyUserErrors || [],
      });
      if (pendingUpdates.length >= FLUSH_SIZE) {
        await flushPending();
      }
    });
    await flushPending();

    if (unmappedRowCount > 0) {
      throw new Error(`UNMAPPED_RESULT_ROWS:${unmappedRowCount}`);
    }

    const completedUpdate = await prisma.editHistory.updateMany({
      where: { id: historyId, shop },
      data: {
        processedCount: {
          increment: successCount,
        },
        status: failureCount > 0 ? "partial" : "completed",
        statusNormalized: normalizeEditHistoryStatus(failureCount > 0 ? "partial" : "completed"),
        executionState: OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
        executionStateNormalized: normalizeEditHistoryExecutionState(
          OPERATION_LIFECYCLE_STATES.SHOPIFY_COMPLETED,
        ),
        batch: mergeBatch(history.batch, {
          resultIngestion: {
            ingestedAt: new Date().toISOString(),
            batchId,
            ingestionRunId,
            successCount,
            failureCount,
            unmappedRowCount,
            rowCount,
          },
        }),
      },
    });
    if (completedUpdate.count !== 1) {
      throw new Error("EDIT_HISTORY_UPDATE_FAILED_SET_SHOPIFY_COMPLETED");
    }

    return {
      historyId,
      shop,
      batchId,
      successCount,
      failureCount,
      unmappedRowCount,
      rowCount,
    };
  }
}
