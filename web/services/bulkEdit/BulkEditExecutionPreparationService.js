import crypto from "crypto";
import { prisma } from "../../config/database.js";
import {
  getFrozenSnapshotSetForExecution,
  listFrozenSnapshotItemsPage,
} from "../../repositories/targetSnapshotSetRepository.js";
import {
  normalizeRules,
  resolveTargetGranularityFromRules,
} from "./bulkEditRuleUtils.js";

function assertExecutableHistory({ history, historyId, executionId }) {
  if (!history) {
    throw new Error("Edit history not found");
  }

  if (executionId && history.executionIdentity && executionId !== history.executionIdentity) {
    throw new Error("STALE_EXECUTION_JOB");
  }

  if (!Array.isArray(history.rules) || history.rules.length === 0) {
    throw new Error("Edit rules not found");
  }

  if (history.cancelRequestedAt) {
    throw new Error("OPERATION_CANCEL_REQUESTED");
  }

  if (!history.targetSnapshotCount || Number(history.targetSnapshotCount) <= 0) {
    throw new Error("TARGET_SNAPSHOT_EMPTY");
  }

  if (!history.targetMirrorBatchId) {
    throw new Error("TARGET_MIRROR_BATCH_ID_REQUIRED");
  }
  const snapshotSetId = String(
    history?.snapshotSetId || history?.batch?.targetSnapshotRef?.snapshotSetId || "",
  ).trim();
  if (!snapshotSetId) {
    throw new Error("FROZEN_SNAPSHOT_SET_REQUIRED");
  }

  const alreadySubmitted =
    history.batch?.shopifyBulkOperation?.id ||
    history.batch?.shopifyBulkOperationId;

  if (alreadySubmitted) {
    throw new Error("SHOPIFY_BULK_OPERATION_ALREADY_SUBMITTED");
  }

  if (!historyId) {
    throw new Error("historyId is required");
  }
}

function assertExecutionStageUsesFrozenPlan({ history }) {
  const hasDynamicTargetingInputs =
    Array.isArray(history?.batch?.filterParams) ||
    Boolean(history?.batch?.filterAst) ||
    Boolean(history?.queryFilter);
  if (hasDynamicTargetingInputs) {
    // freeze metadata may keep these for audit only; execute path must not consume them.
    return;
  }
}

function buildBatchId({
  executionIdentity,
  historyId,
  cursorOrdinal,
  lastOrdinal,
  rowCount,
  retryFailedOnly,
  retryCursorIndex,
}) {
  return crypto
    .createHash("sha1")
    .update(
      [
        executionIdentity || historyId,
        cursorOrdinal ?? "start",
        lastOrdinal ?? "none",
        rowCount,
        retryFailedOnly ? "retry" : "normal",
        retryCursorIndex ?? 0,
      ].join(":"),
    )
    .digest("hex");
}

function getTargetGranularity(history) {
  const fromBatch = String(
    history.batch?.targetGranularity ||
      history.batch?.automaticRuleTargetType ||
      "",
  ).toUpperCase();

  if (fromBatch === "VARIANT" || fromBatch === "PRODUCT") {
    return fromBatch;
  }

  return resolveTargetGranularityFromRules(history.rules);
}

function getBatchLimit(history) {
  const rawLimit = Number(history.batch?.size || 75);

  if (!Number.isFinite(rawLimit) || rawLimit <= 0) {
    return 75;
  }

  return Math.min(rawLimit, 250);
}

function getCursorOrdinal(history) {
  const cursor = history.batch?.lastProductId;

  if (Number.isInteger(cursor)) {
    return cursor;
  }

  return null;
}

function extractPlannedMutationJsonlRow(plannedMutation) {
  if (!plannedMutation || typeof plannedMutation !== "object" || Array.isArray(plannedMutation)) {
    return null;
  }
  const direct = typeof plannedMutation.jsonlRow === "string"
    ? plannedMutation.jsonlRow.trim()
    : "";
  if (direct) return direct;
  if (plannedMutation.productSet || plannedMutation.input || plannedMutation.id) {
    try {
      return JSON.stringify(plannedMutation);
    } catch {
      return null;
    }
  }
  return null;
}

export class BulkEditExecutionPreparationService {
  constructor(session = null) {
    this.session = session;
  }

  async prepareNextExecutionBatch({ historyId, executionId } = {}) {
    const history = await prisma.editHistory.findUnique({
      where: { id: historyId },
      select: {
        id: true,
        shop: true,
        snapshotSetId: true,
        isSpreadsheetEdit: true,
        batch: true,
        rules: true,
        targetMirrorBatchId: true,
        targetSnapshotCount: true,
        executionIdentity: true,
        cancelRequestedAt: true,
      },
    });

    assertExecutableHistory({ history, historyId, executionId });
    assertExecutionStageUsesFrozenPlan({ history });

    const rules = normalizeRules({
      rules: Array.isArray(history.rules) ? history.rules : [],
    });

    const fields = rules.map((rule) => rule.field).filter(Boolean);
    const limit = getBatchLimit(history);
    const cursorOrdinal = getCursorOrdinal(history);
    const targetGranularity = getTargetGranularity(history);

    const retryFailedOnly = Boolean(history.batch?.retryFailedOnly);
    const retryTargetIdentities = Array.isArray(history.batch?.retryTargetIdentities)
      ? history.batch.retryTargetIdentities.filter(Boolean)
      : [];

    const retryCursorIndex = Number.isInteger(history.batch?.retryCursorIndex)
      ? history.batch.retryCursorIndex
      : 0;
    const frozenSnapshotSetId = String(
      history.snapshotSetId || history.batch?.targetSnapshotRef?.snapshotSetId || "",
    ).trim();
    const frozenSnapshotSetOperationId = String(
      history.batch?.targetSnapshotRef?.operationId || history.executionIdentity || "",
    ).trim();
    const frozenSnapshotSet = await getFrozenSnapshotSetForExecution({
      shop: history.shop,
      snapshotSetId: frozenSnapshotSetId,
      operationId: frozenSnapshotSetOperationId || undefined,
    });

    let rows = [];
    let lastProductId = null;
    let hasMore = false;
    let nextRetryCursorIndex = retryCursorIndex;

    if (retryFailedOnly) {
      const pageIdentities = retryTargetIdentities.slice(
        retryCursorIndex,
        retryCursorIndex + limit,
      );

      hasMore =
        retryCursorIndex + pageIdentities.length < retryTargetIdentities.length;

      nextRetryCursorIndex = retryCursorIndex + pageIdentities.length;

      if (pageIdentities.length > 0) {
        const retryPage = await listFrozenSnapshotItemsPage({
          shop: history.shop,
          snapshotSetId: frozenSnapshotSet.id,
          targetKeys: pageIdentities,
          limit,
        });
        rows = retryPage.rows.map((row) => ({
          id: row.id,
          productId: row.productId,
          variantId: row.variantId,
          targetType: row.targetType,
          targetIdentity: row.targetKey,
          plannedMutation: row.plannedMutation,
        }));
        lastProductId = retryPage.cursorTargetKey;
      }
    } else {
      const frozenTargetPage = await listFrozenSnapshotItemsPage({
        shop: history.shop,
        snapshotSetId: frozenSnapshotSet.id,
        cursorTargetKey:
          typeof history.batch?.lastProductId === "string"
            ? history.batch.lastProductId
            : null,
        limit,
        targetType: targetGranularity === "VARIANT" ? "VARIANT" : "PRODUCT",
      });
      rows = frozenTargetPage.rows.map((row) => ({
        id: row.id,
        productId: row.productId,
        variantId: row.variantId,
        targetType: row.targetType,
        targetIdentity: row.targetKey,
        plannedMutation: row.plannedMutation,
      }));
      lastProductId = frozenTargetPage.cursorTargetKey;
      hasMore = frozenTargetPage.hasMore;
    }

    const batchId = buildBatchId({
      executionIdentity: history.executionIdentity,
      historyId,
      cursorOrdinal,
      lastOrdinal: lastProductId,
      rowCount: rows.length,
      retryFailedOnly,
      retryCursorIndex,
    });

    if (!rows.length) {
      return {
        formattedProducts: "",
        changes: [],
        batchId,
        batchTargetCount: 0,
        lastProductId: null,
        hasMore: false,
        nextRetryCursorIndex,
        fields,
      };
    }

    const isCsvFrozenExecution =
      history.isSpreadsheetEdit === true || history.batch?.csvImport === true;
    if (isCsvFrozenExecution) {
      const productIds = [...new Set(rows.map((row) => row.productId).filter(Boolean))];
      const csvRecords = await prisma.changeRecord.findMany({
        where: {
          editHistoryId: historyId,
          shop: history.shop,
          productId: { in: productIds },
        },
        select: {
          productId: true,
          options: true,
        },
      });
      const csvRowByProductId = new Map();
      for (const record of csvRecords) {
        const options =
          record?.options && typeof record.options === "object" && !Array.isArray(record.options)
            ? record.options
            : {};
        const csvMutationRow = typeof options.csvMutationRow === "string"
          ? options.csvMutationRow.trim()
          : "";
        if (csvMutationRow && record.productId) {
          csvRowByProductId.set(record.productId, csvMutationRow);
        }
      }

      const formattedRows = rows
        .map((row) => csvRowByProductId.get(row.productId))
        .filter(Boolean);

      return {
        formattedProducts: formattedRows.join("\n"),
        changes: [],
        batchId,
        batchTargetCount: formattedRows.length,
        lastProductId,
        hasMore,
        nextRetryCursorIndex,
        fields: ["mixed"],
      };
    }

    if (targetGranularity === "VARIANT") {
      const hasMismatch = rows.some(
        (row) => String(row?.targetType || "").toUpperCase() !== "VARIANT",
      );

      if (hasMismatch) {
        throw new Error("Frozen target type mismatch: expected VARIANT targets");
      }
    }

    const formattedRows = [];
    for (const row of rows) {
      const mutationRow = extractPlannedMutationJsonlRow(row.plannedMutation);
      if (!mutationRow) {
        throw new Error(`FROZEN_MUTATION_PLAN_MISSING:${row.id}`);
      }
      formattedRows.push(mutationRow);
    }

    return {
      formattedProducts: formattedRows.join("\n"),
      changes: [],
      batchId,
      batchTargetCount: rows.length,
      lastProductId,
      hasMore,
      nextRetryCursorIndex,
      fields,
    };
  }
}
