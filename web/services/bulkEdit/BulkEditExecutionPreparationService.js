import crypto from "crypto";
import { prisma } from "../../config/database.js";
import { getUpdatedProducts } from "../../helpers/productBulkOperationHelpers/productUpdateHandler.js";
import {
  getFrozenTargetProductIds,
  getFrozenTargetVariantIds,
} from "../productService/productTargetingService.js";
import {
  buildProductInclude,
  hydrateMissingVariantsForProducts,
  normalizeMirrorProductForPreview,
} from "./bulkEditTargetUtils.js";
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

function buildVariantIdsByProduct(rows = []) {
  return rows.reduce((accumulator, row) => {
    const targetType = String(row?.targetType || "").toUpperCase();

    if (targetType !== "VARIANT" || !row.productId || !row.variantId) {
      return accumulator;
    }

    const bucket = accumulator.get(row.productId) || new Set();
    bucket.add(row.variantId);
    accumulator.set(row.productId, bucket);

    return accumulator;
  }, new Map());
}

function filterVariantsForFrozenVariantTargets(product, variantIdsByProduct) {
  if (!variantIdsByProduct.size) {
    return product;
  }

  const allowed = variantIdsByProduct.get(product.id);

  return {
    ...product,
    variants: Array.isArray(product.variants)
      ? product.variants.filter((variant) => allowed?.has(variant.id))
      : [],
  };
}

/**
 * Existing getUpdatedProducts() appears to be rule-oriented.
 *
 * This adapter preserves your current mutation builder behavior while keeping
 * the new service boundary clean.
 *
 * Important:
 * - Long-term, replace this with buildProductMutationInputFromRules().
 * - That future function should apply all rules in memory and emit exactly
 *   one final JSONL row per target identity.
 */
function mergeVariantRows(existing = [], incoming = []) {
  const byId = new Map();
  for (const row of existing) {
    if (row?.id) byId.set(String(row.id), { ...row });
  }
  for (const row of incoming) {
    if (!row?.id) continue;
    const key = String(row.id);
    const prev = byId.get(key) || { id: row.id };
    byId.set(key, { ...prev, ...row });
  }
  return [...byId.values()];
}

function mergeProductSetMutation(base = {}, patch = {}) {
  const merged = { ...base, ...patch };
  if (Array.isArray(base.variants) || Array.isArray(patch.variants)) {
    merged.variants = mergeVariantRows(base.variants || [], patch.variants || []);
  }
  return merged;
}

function mergeMutationRows(rows = []) {
  let mergedRoot = null;
  for (const row of rows) {
    if (!row) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(String(row));
    } catch {
      continue;
    }
    if (!mergedRoot) {
      mergedRoot = parsed;
      continue;
    }
    if (parsed.productSet || mergedRoot.productSet) {
      mergedRoot = {
        ...mergedRoot,
        ...parsed,
        productSet: mergeProductSetMutation(
          mergedRoot.productSet || {},
          parsed.productSet || {},
        ),
      };
    } else {
      mergedRoot = { ...mergedRoot, ...parsed };
    }
  }
  return mergedRoot ? JSON.stringify(mergedRoot) : null;
}

function foldChangeEntries(entries = []) {
  if (!entries.length) return null;
  const base = entries[0];
  const productFieldMap = new Map();
  const variantFieldMap = new Map();

  for (const entry of entries) {
    const productChanges = Array.isArray(entry?.productFieldChanges)
      ? entry.productFieldChanges
      : [];
    for (const change of productChanges) {
      if (!change?.field) continue;
      productFieldMap.set(String(change.field), change);
    }

    const variantChanges = Array.isArray(entry?.variantFieldChanges)
      ? entry.variantFieldChanges
      : [];
    for (const change of variantChanges) {
      if (!change?.field || !change?.variantId) continue;
      const key = `${change.variantId}:${change.field}`;
      variantFieldMap.set(key, change);
    }
  }

  return {
    ...base,
    productFieldChanges: [...productFieldMap.values()],
    variantFieldChanges: [...variantFieldMap.values()],
  };
}

function buildProductMutationInputFromRules({
  product,
  rules,
  changes,
  historyId,
  shop,
  batchId,
  mutationBuilder = getUpdatedProducts,
}) {
  const rows = [];
  const localChangeEntries = [];
  for (const rule of rules) {
    const localRuleChanges = [];
    const result = mutationBuilder({
      product,
      field: rule.field,
      editType: rule.editOption,
      value: rule.value,
      searchKey: rule.searchKey,
      replaceText: rule.replaceText,
      supportValue: rule.supportValue,
      changes: localRuleChanges,
      historyId,
      shop,
      batchId,
    });

    if (result) {
      rows.push(result);
    }
    if (localRuleChanges.length > 0) {
      localChangeEntries.push(...localRuleChanges);
    }
  }

  const merged = mergeMutationRows(rows);
  const foldedChange = foldChangeEntries(localChangeEntries);
  if (foldedChange) {
    changes.push(foldedChange);
  }
  return merged;
}

export const __bulkEditExecutionPreparationTestables = {
  mergeMutationRows,
  foldChangeEntries,
  buildProductMutationInputFromRules,
};

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
        rows = await prisma.targetSnapshot.findMany({
          where: {
            ownerType: "EDIT_HISTORY",
            ownerId: historyId,
            shop: history.shop,
            mirrorBatchId: history.targetMirrorBatchId,
            targetIdentity: { in: pageIdentities },
          },
          orderBy: [{ ordinal: "asc" }, { id: "asc" }],
          select: {
            productId: true,
            variantId: true,
            targetType: true,
            ordinal: true,
          },
        });

        lastProductId = rows.length > 0 ? rows[rows.length - 1].ordinal : null;
      }
    } else {
      const frozenTargetPage =
        targetGranularity === "VARIANT"
          ? await getFrozenTargetVariantIds({
              ownerType: "EDIT_HISTORY",
              ownerId: historyId,
              shop: history.shop,
              mirrorBatchId: history.targetMirrorBatchId,
              limit,
              cursorOrdinal,
            })
          : await getFrozenTargetProductIds({
              ownerType: "EDIT_HISTORY",
              ownerId: historyId,
              shop: history.shop,
              mirrorBatchId: history.targetMirrorBatchId,
              limit,
              cursorOrdinal,
            });

      rows = frozenTargetPage.rows;
      lastProductId = frozenTargetPage.lastOrdinal;
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

    const include = buildProductInclude(fields);

    const safeInclude =
      include?.variants && history.targetMirrorBatchId
        ? {
            variants: {
              where: {
                mirrorBatchId: history.targetMirrorBatchId,
              },
            },
          }
        : include;

    const orderedProductIds = [
      ...new Set(rows.map((row) => row.productId).filter(Boolean)),
    ];

    const variantIdsByProduct = buildVariantIdsByProduct(rows);

    let products = await prisma.product.findMany({
      where: {
        shop: history.shop,
        id: { in: orderedProductIds },
        mirrorBatchId: history.targetMirrorBatchId,
      },
      ...(safeInclude ? { include: safeInclude } : {}),
    });

    if (safeInclude?.variants) {
      products = await hydrateMissingVariantsForProducts(
        products,
        history.shop,
        history.targetMirrorBatchId,
      );
    }

    const productsById = new Map(
      products.map((product) => [product.id, product]),
    );

    const formattedRows = [];
    const changes = [];

    for (const productId of orderedProductIds) {
      const rawProduct = productsById.get(productId);

      if (!rawProduct) {
        continue;
      }

      const normalizedProduct = normalizeMirrorProductForPreview(rawProduct);

      const scopedProduct = filterVariantsForFrozenVariantTargets(
        normalizedProduct,
        variantIdsByProduct,
      );

      const mutationRow = buildProductMutationInputFromRules({
        product: scopedProduct,
        rules,
        changes,
        historyId,
        shop: history.shop,
        batchId,
      });

      if (mutationRow) {
        formattedRows.push(mutationRow);
      }
    }

    return {
      formattedProducts: formattedRows.join("\n"),
      changes,
      batchId,
      batchTargetCount: rows.length,
      lastProductId,
      hasMore,
      nextRetryCursorIndex,
      fields,
    };
  }
}
