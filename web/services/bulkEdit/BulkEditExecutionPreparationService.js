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

const MAX_BATCH_JSONL_BYTES = Number.parseInt(
  process.env.BULK_EDIT_MAX_BATCH_JSONL_BYTES || `${15 * 1024 * 1024}`,
  10,
);

function assertExecutableHistory({ history, historyId, executionId, sessionShop }) {
  if (!history) {
    throw new Error("Edit history not found");
  }

  if (sessionShop && history.shop !== sessionShop) {
    throw new Error("SHOP_MISMATCH");
  }

  if (
    executionId &&
    history.executionIdentity &&
    executionId !== history.executionIdentity
  ) {
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

  if (!history.targetProductMirrorBatchId) {
    throw new Error("TARGET_MIRROR_BATCH_ID_REQUIRED");
  }

  const snapshotSetId = String(
    history?.snapshotSetId ||
      history?.batch?.targetSnapshotRef?.snapshotSetId ||
      "",
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
    history?.snapshotSetId ||
      history?.batch?.targetSnapshotRef?.snapshotSetId ||
      "",
  ).trim();

  if (!snapshotSetId) {
    throw new Error("FROZEN_SNAPSHOT_SET_REQUIRED");
  }

  const executionPlan =
    history?.batch?.executionPlan &&
    typeof history.batch.executionPlan === "object" &&
    !Array.isArray(history.batch.executionPlan);

  if (!executionPlan) {
    throw new Error("EXECUTION_PLAN_REQUIRED");
  }
}

function assertFrozenSnapshotSetMatchesHistory({
  frozenSnapshotSet,
  history,
  expectedOperationId,
}) {
  if (!frozenSnapshotSet) {
    throw new Error("FROZEN_SNAPSHOT_SET_NOT_FOUND");
  }

  if (frozenSnapshotSet.shop && frozenSnapshotSet.shop !== history.shop) {
    throw new Error("SNAPSHOT_SHOP_MISMATCH");
  }

  if (
    expectedOperationId &&
    frozenSnapshotSet.operationId &&
    frozenSnapshotSet.operationId !== expectedOperationId
  ) {
    throw new Error("SNAPSHOT_OPERATION_MISMATCH");
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
    .createHash("sha256")
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

  if (typeof cursor === "string" && cursor.trim()) {
    return cursor.trim();
  }

  return null;
}

function assertPlannedMutationShape(plannedMutation, rowId) {
  if (
    !plannedMutation ||
    typeof plannedMutation !== "object" ||
    Array.isArray(plannedMutation)
  ) {
    throw new Error(`FROZEN_MUTATION_PLAN_INVALID:${rowId}`);
  }

  const hasJsonlRow =
    typeof plannedMutation.jsonlRow === "string" &&
    plannedMutation.jsonlRow.trim();

  const hasStructuredMutation =
    plannedMutation.productSet ||
    plannedMutation.input ||
    plannedMutation.id;

  if (!hasJsonlRow && !hasStructuredMutation) {
    throw new Error(`FROZEN_MUTATION_PLAN_MISSING:${rowId}`);
  }
}

function extractPlannedMutationJsonlRow(plannedMutation, rowId) {
  assertPlannedMutationShape(plannedMutation, rowId);

  const direct =
    typeof plannedMutation.jsonlRow === "string"
      ? plannedMutation.jsonlRow.trim()
      : "";

  if (direct) return direct;

  try {
    return JSON.stringify(plannedMutation);
  } catch {
    throw new Error(`FROZEN_MUTATION_PLAN_UNSERIALIZABLE:${rowId}`);
  }
}

function assertPayloadSize(payload) {
  const size = Buffer.byteLength(payload || "", "utf8");

  if (size > MAX_BATCH_JSONL_BYTES) {
    throw new Error("JSONL_BATCH_TOO_LARGE");
  }
}

export class BulkEditExecutionPreparationService {
  constructor(session = null) {
    this.session = session;
  }

  async prepareNextExecutionBatch({ historyId, executionId } = {}) {
    const shop = String(this.session?.shop || "").trim();
    if (!shop) throw new Error("SHOP_SCOPE_REQUIRED");
    const history = await db.editHistory.findUnique({
      where: { shop_id: { shop, id: historyId } },
      select: {
        id: true,
        shop: true,
        snapshotSetId: true,
        isSpreadsheetEdit: true,
        batch: true,
        rules: true,
        targetProductMirrorBatchId: true,
        targetSnapshotCount: true,
        executionIdentity: true,
        cancelRequestedAt: true,
      },
    });

    assertExecutableHistory({
      history,
      historyId,
      executionId,
      sessionShop: this.session?.shop || null,
    });

    assertExecutionStageUsesFrozenPlan({ history });

    const rules = normalizeRules({
      rules: Array.isArray(history.rules) ? history.rules : [],
    });

    const fields = rules.map((rule) => rule.field).filter(Boolean);
    const limit = getBatchLimit(history);
    const cursorOrdinal = getCursorOrdinal(history);
    const targetGranularity = getTargetGranularity(history);

    const retryFailedOnly = Boolean(history.batch?.retryFailedOnly);

    const retryTargetIdentities = [
      ...new Set(
        Array.isArray(history.batch?.retryTargetIdentities)
          ? history.batch.retryTargetIdentities
              .map((item) => String(item || "").trim())
              .filter(Boolean)
          : [],
      ),
    ];

    const retryCursorIndex = Number.isInteger(history.batch?.retryCursorIndex)
      ? history.batch.retryCursorIndex
      : 0;

    const frozenSnapshotSetId = String(
      history.snapshotSetId ||
        history.batch?.targetSnapshotRef?.snapshotSetId ||
        "",
    ).trim();

    const frozenSnapshotSetOperationId = String(
      history.batch?.targetSnapshotRef?.operationId ||
        history.executionIdentity ||
        "",
    ).trim();

    const frozenSnapshotSet = await getFrozenSnapshotSetForExecution({
      shop: history.shop,
      snapshotSetId: frozenSnapshotSetId,
      operationId: frozenSnapshotSetOperationId || undefined,
    });

    assertFrozenSnapshotSetMatchesHistory({
      frozenSnapshotSet,
      history,
      expectedOperationId: frozenSnapshotSetOperationId,
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
          targetResourceType: row.targetResourceType,
          targetIdentity: row.targetKey,
          fieldPath: row.fieldPath,
          beforeValues: row.beforeValues,
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
        targetResourceType:
          targetGranularity === "VARIANT"
            ? ["VARIANT", "INVENTORY_ITEM", "INVENTORY_LEVEL"]
            : ["PRODUCT", "PRODUCT_OPTION", "COLLECTION_MEMBERSHIP"],
      });

      rows = frozenTargetPage.rows.map((row) => ({
        id: row.id,
        productId: row.productId,
        variantId: row.variantId,
        targetResourceType: row.targetResourceType,
        targetIdentity: row.targetKey,
        fieldPath: row.fieldPath,
        beforeValues: row.beforeValues,
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
      if (!retryFailedOnly && Number(history.targetSnapshotCount || 0) > 0) {
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
      const productIds = [
        ...new Set(rows.map((row) => row.productId).filter(Boolean)),
      ];

      const csvRecords = await db.changeRecord.findMany({
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
          record?.options &&
          typeof record.options === "object" &&
          !Array.isArray(record.options)
            ? record.options
            : {};

        const csvMutationRow =
          typeof options.csvMutationRow === "string"
            ? options.csvMutationRow.trim()
            : "";

        if (csvMutationRow && record.productId) {
          csvRowByProductId.set(record.productId, csvMutationRow);
        }
      }

      const formattedRows = [];

      for (const row of rows) {
        const csvRow = csvRowByProductId.get(row.productId);

        if (!csvRow) {
          throw new Error(`CSV_MUTATION_ROW_MISSING:${row.productId}`);
        }

        formattedRows.push(csvRow);
      }

      const formattedProducts = formattedRows.join("\n");
      assertPayloadSize(formattedProducts);

      return {
        formattedProducts,
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
        (row) => String(row?.targetResourceType || "").toUpperCase() !== "VARIANT",
      );

      if (hasMismatch) {
        throw new Error("Frozen target type mismatch: expected VARIANT targets");
      }
    }

    if (targetGranularity === "PRODUCT") {
      const hasMismatch = rows.some(
        (row) => String(row?.targetResourceType || "").toUpperCase() !== "PRODUCT",
      );

      if (hasMismatch) {
        throw new Error("Frozen target type mismatch: expected PRODUCT targets");
      }
    }

    const seenTargetIdentities = new Set();
    const formattedRows = [];

    for (const row of rows) {
      const targetIdentity = String(row?.targetIdentity || "").trim();

      if (!targetIdentity) {
        throw new Error(`FROZEN_TARGET_IDENTITY_MISSING:${row.id}`);
      }

      if (seenTargetIdentities.has(targetIdentity)) {
        throw new Error(`FROZEN_TARGET_DUPLICATE:${targetIdentity}`);
      }

      seenTargetIdentities.add(targetIdentity);

      const mutationRow = extractPlannedMutationJsonlRow(
        row.plannedMutation,
        row.id,
      );

      formattedRows.push(mutationRow);
    }

    const formattedProducts = formattedRows.join("\n");
    assertPayloadSize(formattedProducts);

    return {
      formattedProducts,
      changes: rows.map((row, shopifyBulkLineNumber) => ({
        productId: row.productId,
        variantId: row.variantId,
        targetResourceType: row.targetResourceType,
        targetIdentity: row.targetIdentity,
        beforeValues: row.beforeValues || {},
        plannedMutation: row.plannedMutation || {},
        shopifyBulkLineNumber,
      })),
      batchId,
      batchTargetCount: rows.length,
      lastProductId,
      hasMore,
      nextRetryCursorIndex,
      fields,
    };
  }
}
