import crypto from "crypto";
import { db } from "../../repositories/repositoryDb.js";
import {
  getFrozenSnapshotSetForExecution,
  listFrozenSnapshotItemsPage,
} from "../../repositories/targetSnapshotSetRepository.js";
import {
  normalizeRules,
  resolveTargetGranularityFromRules,
} from "./bulkEditRuleUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../operationLifecycleStateMachine.js";

const TERMINAL_EXECUTION_STATES = new Set([
  OPERATION_LIFECYCLE_STATES.COMPLETED,
  OPERATION_LIFECYCLE_STATES.PARTIAL_FAILED,
  OPERATION_LIFECYCLE_STATES.FAILED,
  OPERATION_LIFECYCLE_STATES.CANCELLED,
]);

const ALLOWED_PREP_EXECUTION_STATES = new Set([
  OPERATION_LIFECYCLE_STATES.EXECUTING,
  OPERATION_LIFECYCLE_STATES.QUEUED,
  OPERATION_LIFECYCLE_STATES.WAITING_FOR_SHOPIFY_SLOT,
]);

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

  if (TERMINAL_EXECUTION_STATES.has(history.executionState)) {
    throw new Error(`OPERATION_ALREADY_TERMINAL:${history.executionState}`);
  }

  if (!ALLOWED_PREP_EXECUTION_STATES.has(history.executionState)) {
    throw new Error(`OPERATION_NOT_READY_FOR_EXECUTION_PREP:${history.executionState || "UNKNOWN"}`);
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
  const snapshotSetId = String(
    history?.snapshotSetId || history?.batch?.targetSnapshotRef?.snapshotSetId || "",
  ).trim();
  const snapshotOperationId = String(
    history?.batch?.targetSnapshotRef?.operationId || history?.executionIdentity || "",
  ).trim();

  if (!snapshotSetId || !snapshotOperationId) {
    throw new Error("FROZEN_EXECUTION_PLAN_REQUIRED");
  }

  const freezeMode = String(history?.batch?.freezeMode || "").toUpperCase();
  if (freezeMode === "DYNAMIC_AT_EXECUTE" || freezeMode === "LIVE_AT_EXECUTE") {
    throw new Error("LIVE_TARGETING_FORBIDDEN_DURING_EXECUTION");
  }

  if (history?.batch?.frozen === false) {
    throw new Error("EXECUTION_REQUIRES_FROZEN_TARGETS");
  }
}

function buildBatchId({
  executionIdentity,
  historyId,
  cursorTargetKey,
  lastTargetKey,
  snapshotSetId,
  retryFailedOnly,
  retryCursorIndex,
}) {
  return crypto
    .createHash("sha256")
    .update(
      [
        executionIdentity || historyId,
        snapshotSetId,
        cursorTargetKey || "start",
        lastTargetKey || "none",
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

function getCursorTargetKey(history) {
  const cursor = history.batch?.lastProductId;

  if (typeof cursor === "string" && cursor.trim()) {
    return cursor.trim();
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

function assertSnapshotSetReadyForExecution(frozenSnapshotSet) {
  if (!frozenSnapshotSet?.id || frozenSnapshotSet.status !== "FROZEN") {
    throw new Error("FROZEN_TARGET_SNAPSHOT_SET_NOT_FOUND");
  }
}

function assertFrozenTargetTypes({ rows, targetGranularity }) {
  const expectedTargetType = targetGranularity === "VARIANT" ? "VARIANT" : "PRODUCT";
  const mismatch = rows.find(
    (row) => String(row?.targetType || "").toUpperCase() !== expectedTargetType,
  );
  if (mismatch) {
    throw new Error(`Frozen target type mismatch: expected ${expectedTargetType} targets`);
  }
}

function extractCsvFieldsFromRecord(record) {
  const fields = [];
  if (Array.isArray(record?.productFieldChanges) && record.productFieldChanges.length) {
    fields.push(...record.productFieldChanges.map((change) => change?.field).filter(Boolean));
  }
  if (Array.isArray(record?.variantFieldChanges) && record.variantFieldChanges.length) {
    fields.push(...record.variantFieldChanges.map((change) => change?.field).filter(Boolean));
  }
  if (typeof record?.scope === "string" && record.scope.trim() && record.scope !== "mixed") {
    fields.push(record.scope.trim());
  }
  return fields;
}

async function markSnapshotItemsSkipped({ shop, snapshotSetId, rows, reasonCode, reasonMessage }) {
  const rowIds = rows.map((row) => row?.id).filter(Boolean);
  if (!rowIds.length) return;

  await db.$transaction(async (tx) => {
    const skipped = await tx.targetSnapshotItem.updateMany({
      where: {
        id: { in: rowIds },
        shop,
        snapshotSetId,
        executionStatus: "PENDING",
      },
      data: {
        executionStatus: "SKIPPED",
        shopifyErrorCode: reasonCode,
        shopifyErrorMessage: reasonMessage,
        lastExecutionAttemptAt: new Date(),
      },
    });
    const skippedCount = Number(skipped?.count || 0);
    if (skippedCount > 0) {
      await tx.targetSnapshotSet.updateMany({
        where: { id: snapshotSetId, shop, status: "FROZEN" },
        data: {
          skippedCount: { increment: skippedCount },
          pendingCount: { decrement: skippedCount },
        },
      });
    }
  });
}

export class BulkEditExecutionPreparationService {
  constructor(sessionOrOptions = null) {
    this.session = sessionOrOptions?.session || sessionOrOptions;
    this.shop = String(sessionOrOptions?.shop || this.session?.shop || "").trim();
  }

  async prepareNextExecutionBatch({ historyId, executionId, shop: inputShop } = {}) {
    const shop = String(inputShop || this.shop || this.session?.shop || "").trim();
    if (!shop || !historyId) {
      throw new Error("EXECUTION_PREP_REQUIRES_SHOP_AND_HISTORY_ID");
    }

    const history = await db.editHistory.findFirst({
      where: { id: historyId, shop },
      select: {
        id: true,
        shop: true,
        snapshotSetId: true,
        isSpreadsheetEdit: true,
        batch: true,
        rules: true,
        executionState: true,
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
    const cursorTargetKey = getCursorTargetKey(history);
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
    assertSnapshotSetReadyForExecution(frozenSnapshotSet);

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
          cursorTargetKey,
        limit,
        targetType: targetGranularity === "VARIANT" ? "VARIANT" : "PRODUCT",
        executionStatus: "PENDING",
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
      cursorTargetKey,
      lastTargetKey: lastProductId,
      snapshotSetId: frozenSnapshotSet.id,
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
      const csvRecords = await db.changeRecord.findMany({
        where: {
          editHistoryId: historyId,
          shop: history.shop,
          productId: { in: productIds },
        },
        select: {
          productId: true,
          scope: true,
          options: true,
          productFieldChanges: true,
          variantFieldChanges: true,
        },
        take: productIds.length + 1,
      });
      if (csvRecords.length > productIds.length) {
        throw new Error("CSV_CHANGE_RECORD_DUPLICATE_TARGET");
      }
      const csvRowByProductId = new Map();
      const csvFields = new Set();
      for (const record of csvRecords) {
        if (csvRowByProductId.has(record.productId)) {
          throw new Error(`CSV_CHANGE_RECORD_DUPLICATE_TARGET:${record.productId}`);
        }
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
        extractCsvFieldsFromRecord(record).forEach((field) => csvFields.add(field));
      }

      const formattedRows = rows
        .map((row) => csvRowByProductId.get(row.productId))
        .filter(Boolean);

      return {
        formattedProducts: formattedRows.join("\n"),
        changes: csvRecords,
        batchId,
        batchTargetCount: formattedRows.length,
        lastProductId,
        hasMore,
        nextRetryCursorIndex,
        fields: csvFields.size ? [...csvFields] : fields,
      };
    }

    assertFrozenTargetTypes({ rows, targetGranularity });

    const formattedRows = [];
    const skippedRows = [];
    for (const row of rows) {
      const mutationRow = extractPlannedMutationJsonlRow(row.plannedMutation);
      if (!mutationRow) {
        skippedRows.push(row);
        continue;
      }
      formattedRows.push(mutationRow);
    }

    if (skippedRows.length) {
      await markSnapshotItemsSkipped({
        shop: history.shop,
        snapshotSetId: frozenSnapshotSet.id,
        rows: skippedRows,
        reasonCode: "FROZEN_MUTATION_PLAN_MISSING",
        reasonMessage: "Frozen target row is missing a planned mutation payload.",
      });
    }

    return {
      formattedProducts: formattedRows.join("\n"),
      changes: rows,
      batchId,
      batchTargetCount: formattedRows.length,
      lastProductId,
      hasMore,
      nextRetryCursorIndex,
      fields,
    };
  }
}
