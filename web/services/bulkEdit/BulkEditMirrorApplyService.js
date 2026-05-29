import { prisma } from "../../config/database.js";
import { assertSnapshotItemsFullyIngested } from "../targetSnapshotItemIntegrityService.js";

function normalizeFieldName(field) {
  return String(field || "").trim();
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
  switch (normalizeFieldName(field)) {
    case "title":
    case "status":
    case "vendor":
    case "productType":
    case "handle":
    case "templateSuffix":
      return { [field]: value == null ? null : String(value) };
    case "description":
    case "descriptionHtml":
      return { descriptionHtml: value == null ? null : String(value) };
    case "seoTitle":
    case "Meta Title":
      return { seoTitle: value == null ? null : String(value) };
    case "seoDescription":
    case "Meta Description":
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
  const normalized = normalizeFieldName(field);
  switch (normalized) {
    case "sku":
    case "barcode":
    case "taxCode":
    case "inventoryPolicy":
    case "weightUnit":
    case "option1Value":
    case "option2Value":
    case "option3Value":
      return { [normalized]: value == null ? null : String(value) };
    case "price":
    case "compareAtPrice":
    case "cost":
      return { [normalized]: value == null ? null : String(value) };
    case "inventory":
    case "inventoryQuantity":
      return { inventoryQuantity: toIntOrNull(value) };
    case "taxable":
    case "tracked":
    case "physicalProduct":
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
  return fromAfterValues.length > 0 ? fromAfterValues : direct;
}

function extractVariantFieldChanges(record) {
  const fromAfterValues = Array.isArray(record?.afterValues?.variantFieldChanges)
    ? record.afterValues.variantFieldChanges
    : [];
  const direct = Array.isArray(record?.variantFieldChanges) ? record.variantFieldChanges : [];
  return fromAfterValues.length > 0 ? fromAfterValues : direct;
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

export async function applyMirrorFromSuccessfulChangeRecords({
  shop,
  historyId,
}) {
  const [history, store] = await Promise.all([
    prisma.editHistory.findFirst({
      where: { id: historyId, shop },
      select: {
        id: true,
        batch: true,
        targetMirrorBatchId: true,
      },
    }),
    prisma.store.findUnique({
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
  if (!snapshotSetId) {
    throw new Error("MIRROR_APPLY_SNAPSHOT_SET_REQUIRED");
  }

  const mirrorBatchId = String(
    store?.activeMirrorBatchId || history?.targetMirrorBatchId || "",
  ).trim();
  if (!mirrorBatchId) {
    return {
      attemptedRows: 0,
      appliedRows: 0,
      unresolvedRows: 0,
      appliedProductRows: 0,
      appliedVariantRows: 0,
      mirrorBatchId: null,
    };
  }

  const rows = await prisma.changeRecord.findMany({
    where: {
      shop,
      editHistoryId: historyId,
      status: "SUCCESS",
    },
    select: {
      id: true,
      productId: true,
      variantId: true,
      productFieldChanges: true,
      variantFieldChanges: true,
      afterValues: true,
      options: true,
    },
  });

  let appliedRows = 0;
  let unresolvedRows = 0;
  let appliedProductRows = 0;
  let appliedVariantRows = 0;

  const targetKeys = rows
    .map((row) => String(row?.targetIdentity || "").trim())
    .filter(Boolean);
  const snapshotRows = targetKeys.length
    ? await prisma.targetSnapshotItem.findMany({
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
      })
    : [];
  assertSnapshotItemsFullyIngested(snapshotRows, "mirror_apply");

  for (const row of rows) {
    const { productPatch, variantPatches } = buildMirrorPatches(row);
    let rowApplied = false;

    if (Object.keys(productPatch).length > 0 && row.productId) {
      // eslint-disable-next-line no-await-in-loop
      const updated = await prisma.product.updateMany({
        where: {
          shop,
          id: String(row.productId),
          mirrorBatchId,
        },
        data: productPatch,
      });
      if (Number(updated?.count || 0) > 0) {
        rowApplied = true;
        appliedProductRows += Number(updated.count);
      }
    }

    for (const [variantId, variantPatch] of variantPatches.entries()) {
      // eslint-disable-next-line no-await-in-loop
      const updated = await prisma.variant.updateMany({
        where: {
          shop,
          id: String(variantId),
          mirrorBatchId,
        },
        data: variantPatch,
      });
      if (Number(updated?.count || 0) > 0) {
        rowApplied = true;
        appliedVariantRows += Number(updated.count);
      }
    }

    const previousOptions =
      row.options && typeof row.options === "object" && !Array.isArray(row.options)
        ? row.options
        : {};

    // eslint-disable-next-line no-await-in-loop
    await prisma.changeRecord.update({
      where: { id: row.id },
      data: {
        options: {
          ...previousOptions,
          mirrorApplyStatus: rowApplied ? "APPLIED_PENDING_RECONCILE" : "UNRESOLVED",
          mirrorAppliedAt: rowApplied ? new Date().toISOString() : null,
          mirrorBatchId,
        },
      },
    });

    if (rowApplied) appliedRows += 1;
    else unresolvedRows += 1;
  }

  return {
    attemptedRows: rows.length,
    appliedRows,
    unresolvedRows,
    appliedProductRows,
    appliedVariantRows,
    mirrorBatchId,
  };
}
