import { createRequire } from "node:module";
import { db } from "../../repositories/repositoryDb.js";
import { assertSnapshotItemsFullyIngested } from "../targetSnapshotItemIntegrityService.js";
import {
  mirrorFinalizationResults,
  mirrorPendingRecords,
} from "../../utils/metricsUtils.js";

const require = createRequire(import.meta.url);
const prismaGenerated = require("../../generated/prisma/index.js");
const { Prisma } = prismaGenerated;

const PAGE_SIZE = 1000;
const CHECKPOINT_EVERY_PAGES = 10;
const MAX_MIRROR_APPLY_PAGES = 10000;
const MIRROR_ELIGIBLE_CHANGE_RECORD_STATUSES = ["SUCCESS", "VERIFIED", "APPLIED"];

function normalizeFieldName(field) {
  return String(field || "").trim();
}

function normalizeFieldKey(field) {
  return normalizeFieldName(field)
    .replace(/[\s_-]+/g, "")
    .toLowerCase();
}

function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalProductFieldName(field) {
  switch (normalizeFieldKey(field)) {
    case "title":
      return "title";
    case "status":
      return "status";
    case "vendor":
      return "vendor";
    case "producttype":
      return "productType";
    case "handle":
      return "handle";
    case "templatesuffix":
      return "templateSuffix";
    default:
      return normalizeFieldName(field);
  }
}

function canonicalVariantFieldName(field) {
  switch (normalizeFieldKey(field)) {
    case "sku":
      return "sku";
    case "barcode":
      return "barcode";
    case "taxcode":
      return "taxCode";
    case "inventorypolicy":
      return "inventoryPolicy";
    case "weightunit":
      return "weightUnit";
    case "option1value":
      return "option1Value";
    case "option2value":
      return "option2Value";
    case "option3value":
      return "option3Value";
    case "taxable":
      return "taxable";
    case "tracked":
      return "tracked";
    case "physicalproduct":
      return "physicalProduct";
    case "weight":
      return "weight";
    default:
      return normalizeFieldName(field);
  }
}

function normalizeScalar(value) {
  if (value === undefined) return null;
  return value;
}

function toIntOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.trunc(num);
}

function toFloatOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num;
}

function toDecimalOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  try {
    return new Prisma.Decimal(String(value));
  } catch {
    return null;
  }
}

function toBooleanOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes"].includes(normalized)) return true;
    if (["false", "0", "no"].includes(normalized)) return false;
  }
  return null;
}

function mapProductFieldToMirrorPatch(field, rawValue) {
  const value = normalizeScalar(rawValue);
  const normalized = canonicalProductFieldName(field);
  switch (normalizeFieldKey(field)) {
    case "title":
    case "status":
    case "vendor":
    case "producttype":
    case "handle":
    case "templatesuffix":
      return { [normalized]: value == null ? null : String(value) };
    case "description":
    case "descriptionhtml":
      return { descriptionHtml: value == null ? null : String(value) };
    case "seotitle":
    case "metatitle":
      return { seoTitle: value == null ? null : String(value) };
    case "seodescription":
    case "metadescription":
      return { seoDescription: value == null ? null : String(value) };
    case "tags":
      if (Array.isArray(value)) return { tags: value.map((item) => String(item)) };
      if (typeof value === "string") {
        return { tags: value.split(",").map((item) => item.trim()).filter(Boolean) };
      }
      return null;
    default:
      return null;
  }
}

function mapVariantFieldToMirrorPatch(field, rawValue) {
  const value = normalizeScalar(rawValue);
  const normalized = canonicalVariantFieldName(field);
  switch (normalizeFieldKey(field)) {
    case "sku":
    case "barcode":
    case "taxcode":
    case "inventorypolicy":
    case "weightunit":
    case "option1value":
    case "option2value":
    case "option3value":
      return { [normalized]: value == null ? null : String(value) };
    case "price":
      return { price: toDecimalOrNull(value) };
    case "compareatprice":
      return { compareAtPrice: toDecimalOrNull(value) };
    case "cost":
      return { cost: toDecimalOrNull(value) };
    case "inventory":
    case "inventoryquantity":
      return { inventoryQuantity: toIntOrNull(value) };
    case "taxable":
    case "tracked":
    case "physicalproduct":
      return { [normalized]: toBooleanOrNull(value) };
    case "weight":
      return { weight: toFloatOrNull(value) };
    default:
      return null;
  }
}

function extractProductFieldChanges(record) {
  const fromAfterValues = Array.isArray(record?.afterValues?.productFieldChanges)
    ? record.afterValues.productFieldChanges
    : [];
  const direct = Array.isArray(record?.productFieldChanges) ? record.productFieldChanges : [];
  return mergeFieldChanges(direct, fromAfterValues);
}

function extractVariantFieldChanges(record) {
  const fromAfterValues = Array.isArray(record?.afterValues?.variantFieldChanges)
    ? record.afterValues.variantFieldChanges
    : [];
  const direct = Array.isArray(record?.variantFieldChanges) ? record.variantFieldChanges : [];
  return mergeVariantFieldChanges(direct, fromAfterValues);
}

function mergeFieldChanges(...sources) {
  const byField = new Map();
  for (const source of sources) {
    for (const change of Array.isArray(source) ? source : []) {
      const key = normalizeFieldKey(change?.field);
      if (key) byField.set(key, change);
    }
  }
  return [...byField.values()];
}

function mergeVariantFieldChanges(...sources) {
  const byVariantAndField = new Map();
  for (const source of sources) {
    for (const group of Array.isArray(source) ? source : []) {
      const variantId = String(group?.variantId || "").trim();
      const entries = Array.isArray(group?.changes)
        ? group.changes
        : group?.field
          ? [group]
          : [];
      for (const entry of entries) {
        const fieldKey = normalizeFieldKey(entry?.field);
        if (!fieldKey) continue;
        byVariantAndField.set(`${variantId}:${fieldKey}`, {
          ...entry,
          variantId: variantId || entry?.variantId || null,
        });
      }
    }
  }
  return [...byVariantAndField.values()];
}

function buildMirrorPatches(record) {
  const productPatch = {};
  const variantPatches = new Map();

  const productFieldChanges = extractProductFieldChanges(record);
  for (const change of productFieldChanges) {
    const field = String(change?.field || "").trim();
    if (!field) continue;
    const value = change?.newValue ?? change?.value ?? change?.nextValue ?? null;
    const mapped = mapProductFieldToMirrorPatch(field, value);
    if (mapped) Object.assign(productPatch, mapped);
  }

  const variantFieldChanges = extractVariantFieldChanges(record);
  for (const changeGroup of variantFieldChanges) {
    const variantId = String(changeGroup?.variantId || record?.variantId || "").trim();
    if (!variantId) continue;
    const current = variantPatches.get(variantId) || {};

    const entries = Array.isArray(changeGroup?.changes)
      ? changeGroup.changes
      : changeGroup?.field
        ? [changeGroup]
        : [];

    for (const entry of entries) {
      const field = String(entry?.field || "").trim();
      if (!field) continue;
      const value = entry?.newValue ?? entry?.value ?? entry?.nextValue ?? null;
      const mapped = mapVariantFieldToMirrorPatch(field, value);
      if (mapped) Object.assign(current, mapped);
    }

    if (Object.keys(current).length > 0) {
      variantPatches.set(variantId, current);
    }
  }

  return {
    productPatch,
    variantPatches,
  };
}

function mergeBatch(existingBatch, patch) {
  return {
    ...(existingBatch && typeof existingBatch === "object" ? existingBatch : {}),
    ...patch,
  };
}

function readBatchObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function addPatchGroup(groups, patch, id) {
  const keys = Object.keys(patch || {});
  if (!keys.length || !id) return;
  const key = stableStringify(patch);
  const existing = groups.get(key) || { patch, ids: new Set() };
  existing.ids.add(String(id));
  groups.set(key, existing);
}

function buildPatchMismatchWhere(patch) {
  return {
    OR: Object.entries(patch || {}).map(([field, value]) => ({
      [field]: { not: value },
    })),
  };
}

function buildMirrorApplyOptions({ status, mirrorBatchId, appliedAt = null, reason = null }) {
  return {
    mirrorApplyStatus: status,
    mirrorAppliedAt: appliedAt,
    mirrorBatchId,
    ...(reason ? { mirrorApplyReason: reason } : {}),
  };
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSnapshotItemFullyIngested(row) {
  return (
    isObject(row?.plannedMutation) &&
    Object.keys(row.plannedMutation).length > 0 &&
    isObject(row?.beforeValues) &&
    Object.keys(row.beforeValues).length > 0
  );
}

async function bulkMarkChangeRecords({
  client = db,
  shop,
  rowIds,
  options,
  mirrorStatus = null,
  mirrorAppliedAt = null,
}) {
  if (!rowIds.length) return;
  await client.changeRecord.updateMany({
    where: { id: { in: rowIds }, shop },
    data: {
      options,
      ...(mirrorStatus ? { mirrorStatus } : {}),
      ...(mirrorAppliedAt ? { mirrorAppliedAt } : {}),
    },
  });
}

export async function applyMirrorFromSuccessfulChangeRecords({
  shop,
  historyId,
  finalStatus = null,
  finalStatusNormalized = null,
}) {
  const [history, store] = await Promise.all([
    db.editHistory.findFirst({
      where: { id: historyId, shop },
      select: {
        id: true,
        batch: true,
        type: true,
        targetMirrorBatchId: true,
      },
    }),
    db.store.findUnique({
      where: { shopUrl: shop },
      select: { activeMirrorBatchId: true },
    }),
  ]);

  if (!history) {
    throw new Error("MIRROR_APPLY_HISTORY_NOT_FOUND");
  }

  const snapshotSetId = String(
    history?.batch?.targetSnapshotRef?.snapshotSetId || "",
  ).trim();
  const isUndoJob = String(history.type || "").toUpperCase() === "UNDO";
  if (!snapshotSetId && !isUndoJob) {
    throw new Error("MIRROR_APPLY_SNAPSHOT_SET_REQUIRED");
  }

  const mirrorBatchId = String(
    store?.activeMirrorBatchId || "",
  ).trim();
  if (!mirrorBatchId) {
    throw new Error("MIRROR_APPLY_ACTIVE_MIRROR_BATCH_REQUIRED");
  }
  const targetMirrorBatchId = String(history?.targetMirrorBatchId || "").trim();
  if (!targetMirrorBatchId || mirrorBatchId !== targetMirrorBatchId) {
    const error = new Error("MIRROR_APPLY_ACTIVE_BATCH_MISMATCH");
    error.details = {
      shop,
      historyId,
      activeMirrorBatchId: mirrorBatchId,
      targetMirrorBatchId,
    };
    throw error;
  }

  let batchState = readBatchObject(history.batch);
  const priorMirrorApply = readBatchObject(batchState.mirrorApply);
  let attemptedRows = Number(priorMirrorApply.attemptedRows || 0);
  let appliedRows = Number(priorMirrorApply.appliedRows || 0);
  let unresolvedRows = Number(priorMirrorApply.unresolvedRows || 0);
  let missingMirrorRows = Number(priorMirrorApply.missingMirrorRows || 0);
  let appliedProductRows = Number(priorMirrorApply.appliedProductRows || 0);
  let appliedVariantRows = Number(priorMirrorApply.appliedVariantRows || 0);
  let cursorId = String(priorMirrorApply.lastAppliedChangeRecordId || "").trim() || null;
  let cursorCreatedAt = priorMirrorApply.lastAppliedChangeRecordCreatedAt
    ? new Date(priorMirrorApply.lastAppliedChangeRecordCreatedAt)
    : null;
  const resumedFromChangeRecordId = cursorId;
  let mirrorFinalizationResult = resumedFromChangeRecordId
    ? "CRASH_RECOVERED"
    : "ATOMIC_SUCCESS";
  let pageCount = 0;

  const flushMirrorApplyCheckpoint = async ({ status = "IN_PROGRESS" } = {}) => {
    batchState = mergeBatch(batchState, {
      mirrorApply: {
        ...readBatchObject(batchState.mirrorApply),
        status,
        attemptedRows,
        appliedRows,
        unresolvedRows,
        missingMirrorRows,
        appliedProductRows,
        appliedVariantRows,
        mirrorBatchId,
        lastAppliedChangeRecordId: cursorId,
        lastAppliedChangeRecordCreatedAt: cursorCreatedAt?.toISOString?.() || null,
        checkpointedAt: new Date().toISOString(),
      },
    });
    await db.editHistory.updateMany({
      where: { id: historyId, shop },
      data: { batch: batchState },
    });
  };

  while (true) {
    pageCount += 1;
    if (pageCount > MAX_MIRROR_APPLY_PAGES) {
      throw new Error("MIRROR_APPLY_PAGE_LIMIT_EXCEEDED");
    }

    const rows = await db.changeRecord.findMany({
      where: {
        shop,
        editHistoryId: historyId,
        status: { in: MIRROR_ELIGIBLE_CHANGE_RECORD_STATUSES },
        mirrorStatus: "MIRROR_PENDING",
        ...(cursorId && cursorCreatedAt
          ? {
            OR: [
              { createdAt: { gt: cursorCreatedAt } },
              { createdAt: cursorCreatedAt, id: { gt: cursorId } },
            ],
          }
          : cursorId
            ? { id: { gt: cursorId } }
            : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: PAGE_SIZE,
      select: {
        id: true,
        createdAt: true,
        targetIdentity: true,
        productId: true,
        variantId: true,
        productFieldChanges: true,
        variantFieldChanges: true,
        beforeValues: true,
        afterValues: true,
      },
    });
    if (!rows.length) break;
    attemptedRows += rows.length;

    const targetKeys = rows
      .map((row) => String(row?.targetIdentity || "").trim())
      .filter(Boolean);
    if (targetKeys.length !== rows.length) {
      const invalidRows = rows.filter((row) => !String(row?.targetIdentity || "").trim());
      const invalidIds = invalidRows.map((row) => row.id);
      unresolvedRows += invalidIds.length;
      await bulkMarkChangeRecords({
        shop,
        rowIds: invalidIds,
        mirrorStatus: "MIRROR_FAILED",
        options: buildMirrorApplyOptions({
          status: "UNRESOLVED",
          mirrorBatchId,
          reason: "MIRROR_APPLY_TARGET_IDENTITY_REQUIRED",
        }),
      });
    }

    const snapshotRows = isUndoJob
      ? rows.map((row) => ({
        id: row.id,
        targetKey: row.targetIdentity,
        plannedMutation: row.afterValues,
        beforeValues: row.beforeValues,
      }))
      : await db.targetSnapshotItem.findMany({
        where: {
          shop,
          snapshotSetId,
          targetKey: { in: targetKeys },
          executionStatus: { in: ["SUCCEEDED", "VERIFIED"] },
        },
        select: {
          id: true,
          targetKey: true,
          plannedMutation: true,
          beforeValues: true,
        },
      });
    const snapshotRowsByTargetKey = new Map(
      snapshotRows.map((row) => [String(row.targetKey || ""), row]),
    );

    const missingSnapshotRows = rows.filter((row) => {
      const targetKey = String(row?.targetIdentity || "").trim();
      return targetKey && !snapshotRowsByTargetKey.has(targetKey);
    });
    if (missingSnapshotRows.length) {
      unresolvedRows += missingSnapshotRows.length;
      await bulkMarkChangeRecords({
        shop,
        rowIds: missingSnapshotRows.map((row) => row.id),
        mirrorStatus: "MIRROR_FAILED",
        options: buildMirrorApplyOptions({
          status: "UNRESOLVED",
          mirrorBatchId,
          reason: "MIRROR_APPLY_SNAPSHOT_ITEM_MISSING",
        }),
      });
    }

    const corruptSnapshotRows = snapshotRows.filter((row) => !isSnapshotItemFullyIngested(row));
    if (corruptSnapshotRows.length) {
      const corruptTargetKeys = new Set(corruptSnapshotRows.map((row) => String(row?.targetKey || "")));
      const badRows = rows.filter((row) => corruptTargetKeys.has(String(row?.targetIdentity || "").trim()));
      if (badRows.length) {
        unresolvedRows += badRows.length;
        await bulkMarkChangeRecords({
          shop,
          rowIds: badRows.map((row) => row.id),
          mirrorStatus: "MIRROR_FAILED",
          options: buildMirrorApplyOptions({
            status: "UNRESOLVED",
            mirrorBatchId,
            reason: "TARGET_SNAPSHOT_ITEM_NOT_FULLY_INGESTED",
          }),
        });
      }
    }
    const integrityRows = snapshotRows.filter((row) => isSnapshotItemFullyIngested(row));
    assertSnapshotItemsFullyIngested(integrityRows, "mirror_apply");

    const eligibleTargetKeys = new Set(integrityRows.map((row) => String(row?.targetKey || "")));
    const eligibleRows = rows.filter((row) =>
      eligibleTargetKeys.has(String(row?.targetIdentity || "").trim()));
    const productGroups = new Map();
    const variantGroups = new Map();
    const rowPlans = new Map();

    for (const row of rows) {
      if (!eligibleTargetKeys.has(String(row?.targetIdentity || "").trim())) continue;
      const { productPatch, variantPatches } = buildMirrorPatches(row);
      const productId = String(row.productId || "").trim();
      addPatchGroup(productGroups, productPatch, productId);
      const variantIds = [];
      for (const [variantId, variantPatch] of variantPatches.entries()) {
        addPatchGroup(variantGroups, variantPatch, variantId);
        variantIds.push(String(variantId));
      }
      rowPlans.set(row.id, {
        productId,
        hasProductPatch: Object.keys(productPatch).length > 0,
        variantIds,
      });
    }

    const productIds = [...new Set([...rowPlans.values()]
      .filter((plan) => plan.hasProductPatch && plan.productId)
      .map((plan) => plan.productId))];
    const variantIds = [...new Set([...rowPlans.values()].flatMap((plan) => plan.variantIds))];
    const pageResult = await db.$transaction(async (tx) => {
      const [existingProducts, existingVariants] = await Promise.all([
        productIds.length
          ? tx.product.findMany({
            where: { shop, mirrorBatchId, id: { in: productIds } },
            select: { id: true },
          })
          : [],
        variantIds.length
          ? tx.variant.findMany({
            where: { shop, mirrorBatchId, id: { in: variantIds } },
            select: { id: true },
          })
          : [],
      ]);
      const existingProductIds = new Set(existingProducts.map((row) => String(row.id)));
      const existingVariantIds = new Set(existingVariants.map((row) => String(row.id)));

      const productUpdateResults = [];
      for (const group of productGroups.values()) {
        const ids = [...group.ids].filter((id) => existingProductIds.has(id));
        if (!ids.length) continue;
        // Idempotent replay: only write mirror rows whose current value differs.
        // eslint-disable-next-line no-await-in-loop
        productUpdateResults.push(await tx.product.updateMany({
          where: {
            shop,
            mirrorBatchId,
            id: { in: ids },
            ...buildPatchMismatchWhere(group.patch),
          },
          data: group.patch,
        }));
      }
      const variantUpdateResults = [];
      for (const group of variantGroups.values()) {
        const ids = [...group.ids].filter((id) => existingVariantIds.has(id));
        if (!ids.length) continue;
        // eslint-disable-next-line no-await-in-loop
        variantUpdateResults.push(await tx.variant.updateMany({
          where: {
            shop,
            mirrorBatchId,
            id: { in: ids },
            ...buildPatchMismatchWhere(group.patch),
          },
          data: group.patch,
        }));
      }

      const appliedRowIds = [];
      const missingMirrorRowIds = [];
      const unresolvedRowIds = [];
      for (const row of eligibleRows) {
        const plan = rowPlans.get(row.id);
        const productApplied = plan?.hasProductPatch && existingProductIds.has(plan.productId);
        const variantApplied = (plan?.variantIds || []).some((variantId) => existingVariantIds.has(variantId));
        if (productApplied || variantApplied) {
          appliedRowIds.push(row.id);
        } else if (plan?.hasProductPatch || (plan?.variantIds || []).length) {
          missingMirrorRowIds.push(row.id);
        } else {
          unresolvedRowIds.push(row.id);
        }
      }

      const appliedAt = new Date();
      await bulkMarkChangeRecords({
        client: tx,
        shop,
        rowIds: appliedRowIds,
        mirrorStatus: "MIRROR_APPLIED",
        mirrorAppliedAt: appliedAt,
        options: buildMirrorApplyOptions({
          status: "MIRROR_APPLIED",
          mirrorBatchId,
          appliedAt: appliedAt.toISOString(),
        }),
      });
      await bulkMarkChangeRecords({
        client: tx,
        shop,
        rowIds: missingMirrorRowIds,
        mirrorStatus: "MIRROR_FAILED",
        options: buildMirrorApplyOptions({
          status: "MIRROR_TARGET_MISSING",
          mirrorBatchId,
          reason: "TARGET_NOT_FOUND_IN_ACTIVE_MIRROR",
        }),
      });
      await bulkMarkChangeRecords({
        client: tx,
        shop,
        rowIds: unresolvedRowIds,
        mirrorStatus: "MIRROR_FAILED",
        options: buildMirrorApplyOptions({
          status: "UNRESOLVED",
          mirrorBatchId,
          reason: "NO_MIRROR_PATCH_BUILT",
        }),
      });

      return {
        appliedRowIds,
        missingMirrorRowIds,
        unresolvedRowIds,
        appliedProductRows: productUpdateResults.reduce(
          (sum, result) => sum + Number(result?.count || 0),
          0,
        ),
        appliedVariantRows: variantUpdateResults.reduce(
          (sum, result) => sum + Number(result?.count || 0),
          0,
        ),
      };
    });
    const {
      appliedRowIds,
      missingMirrorRowIds,
      unresolvedRowIds,
    } = pageResult;
    appliedProductRows += pageResult.appliedProductRows;
    appliedVariantRows += pageResult.appliedVariantRows;
    appliedRows += appliedRowIds.length;
    missingMirrorRows += missingMirrorRowIds.length;
    unresolvedRows += unresolvedRowIds.length;

    cursorId = rows[rows.length - 1].id;
    cursorCreatedAt = rows[rows.length - 1].createdAt;
    if (pageCount % CHECKPOINT_EVERY_PAGES === 0 || rows.length < PAGE_SIZE) {
      await flushMirrorApplyCheckpoint({ status: "IN_PROGRESS" });
    }
    if (rows.length < PAGE_SIZE) break;
  }

  await flushMirrorApplyCheckpoint({ status: "APPLY_COMPLETED" });

  if (finalStatus && finalStatusNormalized) {
    await db.$transaction(async (tx) => {
      const pendingRows = await tx.changeRecord.count({
        where: {
          shop,
          editHistoryId: historyId,
          OR: [
            { status: "PENDING" },
            {
              status: { in: MIRROR_ELIGIBLE_CHANGE_RECORD_STATUSES },
              mirrorStatus: "MIRROR_PENDING",
            },
          ],
        },
      });
      if (pendingRows > 0) {
        throw new Error("MIRROR_APPLY_PENDING_ROWS_REMAIN");
      }
      const finalized = await tx.editHistory.updateMany({
        where: {
          id: historyId,
          shop,
          status: { notIn: ["completed", "partial"] },
        },
        data: {
          status: finalStatus,
          statusNormalized: finalStatusNormalized,
          ...(isUndoJob
            ? {
              executionState: finalStatus === "partial" ? "partial" : "completed",
              executionStateNormalized: finalStatus === "partial" ? "PARTIAL" : "COMPLETED",
              completedAt: new Date(),
            }
            : {}),
        },
      });
      if (finalized.count !== 1) {
        const existing = await tx.editHistory.findFirst({
          where: { id: historyId, shop },
          select: { status: true },
        });
        if (String(existing?.status || "").toLowerCase() !== String(finalStatus).toLowerCase()) {
          throw new Error("MIRROR_APPLY_JOB_FINALIZATION_REJECTED");
        }
        mirrorFinalizationResult = "IDEMPOTENT_SKIP";
      }
    });
    mirrorPendingRecords.set({ shop }, 0);
    mirrorFinalizationResults.inc({ shop, result: mirrorFinalizationResult });
  }

  return {
    attemptedRows,
    appliedRows,
    unresolvedRows,
    missingMirrorRows,
    appliedProductRows,
    appliedVariantRows,
    mirrorBatchId,
    resumedFromChangeRecordId,
    lastAppliedChangeRecordId: cursorId,
  };
}
