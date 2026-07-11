import { db } from "../../repositories/repositoryDb.js";
import { assertSnapshotItemsFullyIngested } from "../targetSnapshotItemIntegrityService.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";

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
    db.editHistory.findFirst({
      where: { id: historyId, shop },
      select: {
        id: true,
        batch: true,
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

  const rows = await db.changeRecord.findMany({
    where: {
      shop,
      editHistoryId: historyId,
      status: { in: ["SUCCESS", "VERIFIED"] },
    },
    select: {
      id: true,
      targetIdentity: true,
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
    ? await db.targetSnapshotItem.findMany({
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
      const updated = await db.product.updateMany({
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
      const updated = await db.variant.updateMany({
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
    await db.changeRecord.update({
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

function stripHtml(value) {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeProductStatus(value) {
  const status = String(value || "UNKNOWN").toUpperCase();
  return ["ACTIVE", "DRAFT", "ARCHIVED"].includes(status) ? status : "UNKNOWN";
}

function productDataFromShopify(node) {
  const descriptionHtml = node?.descriptionHtml ?? null;
  return {
    title: String(node?.title || ""),
    handle: node?.handle == null ? null : String(node.handle),
    status: String(node?.status || "UNKNOWN"),
    statusNormalized: normalizeProductStatus(node?.status),
    vendor: node?.vendor == null ? null : String(node.vendor),
    productType: node?.productType == null ? null : String(node.productType),
    tags: Array.isArray(node?.tags) ? node.tags.map(String) : [],
    descriptionHtml,
    descriptionText: stripHtml(descriptionHtml),
    seoTitle: node?.seo?.title ?? null,
    seoDescription: node?.seo?.description ?? null,
    updatedAt: node?.updatedAt ? new Date(node.updatedAt) : undefined,
    lastReconciledAt: new Date(),
    lastSourceKind: "BULK_EDIT_VERIFICATION",
  };
}

function variantDataFromShopify(node, productId) {
  return {
    productId,
    title: node?.title ?? null,
    sku: node?.sku ?? null,
    barcode: node?.barcode ?? null,
    price: node?.price ?? null,
    compareAtPrice: node?.compareAtPrice ?? null,
    inventoryQuantity: node?.inventoryQuantity ?? null,
    taxable: node?.taxable ?? null,
    selectedOptionsJson: Array.isArray(node?.selectedOptions) ? node.selectedOptions : undefined,
    option1Value: node?.selectedOptions?.[0]?.value ?? null,
    option2Value: node?.selectedOptions?.[1]?.value ?? null,
    option3Value: node?.selectedOptions?.[2]?.value ?? null,
  };
}

export async function reconcileVerifiedShopifyStateIntoActiveMirror({
  shop,
  productsById = new Map(),
  variantsById = new Map(),
}) {
  if (!(productsById instanceof Map) || productsById.size === 0) {
    return { mirrorBatchId: null, reconciledProducts: 0, reconciledVariants: 0 };
  }
  const store = await db.store.findUnique({
    where: { shopUrl: shop },
    select: { activeMirrorBatchId: true },
  });
  const mirrorBatchId = String(store?.activeMirrorBatchId || "").trim();
  if (!mirrorBatchId) throw new Error("VERIFIED_MIRROR_ACTIVE_BATCH_REQUIRED");

  let reconciledProducts = 0;
  let reconciledVariants = 0;

  for (const [productId, product] of productsById.entries()) {
    if (!productId || product?.__typename !== "Product") continue;
    const embeddedVariants = Array.isArray(product?.variants?.nodes)
      ? product.variants.nodes
      : [];

    // Resolve the active generation inside each short transaction so a mirror
    // generation switch cannot redirect writes to a retired batch.
    // eslint-disable-next-line no-await-in-loop
    const counts = await db.$transaction(async (tx) => {
      const currentStore = await tx.store.findUnique({
        where: { shopUrl: shop },
        select: { activeMirrorBatchId: true },
      });
      const activeBatchId = String(currentStore?.activeMirrorBatchId || "").trim();
      if (!activeBatchId) throw new Error("VERIFIED_MIRROR_ACTIVE_BATCH_REQUIRED");

      const productData = productDataFromShopify(product);
      await tx.product.upsert({
        where: { shop_id_mirrorBatchId: { shop, id: productId, mirrorBatchId: activeBatchId } },
        create: { shop, id: productId, mirrorBatchId: activeBatchId, ...productData },
        update: productData,
      });

      const authoritativeVariants = new Map();
      for (const variant of embeddedVariants) {
        if (variant?.id) authoritativeVariants.set(String(variant.id), variant);
      }
      for (const variant of variantsById.values()) {
        if (variant?.id && (!variant?.product?.id || String(variant.product.id) === productId)) {
          authoritativeVariants.set(String(variant.id), variant);
        }
      }

      for (const [variantId, variant] of authoritativeVariants.entries()) {
        const data = variantDataFromShopify(variant, productId);
        // eslint-disable-next-line no-await-in-loop
        await tx.variant.upsert({
          where: { shop_id_mirrorBatchId: { shop, id: variantId, mirrorBatchId: activeBatchId } },
          create: { shop, id: variantId, mirrorBatchId: activeBatchId, ...data },
          update: data,
        });
      }

      const aggregate = await tx.variant.aggregate({
        where: { shop, productId, mirrorBatchId: activeBatchId },
        _sum: { inventoryQuantity: true },
        _count: { _all: true },
      });
      await tx.product.update({
        where: { shop_id_mirrorBatchId: { shop, id: productId, mirrorBatchId: activeBatchId } },
        data: {
          totalInventory: aggregate._sum.inventoryQuantity,
          variantCount: aggregate._count._all,
        },
      });

      return { products: 1, variants: authoritativeVariants.size };
    });

    reconciledProducts += counts.products;
    reconciledVariants += counts.variants;
  }

  await Promise.all([
    clearKeyCaches(`${shop}:ProductFetch:`),
    clearKeyCaches(`${shop}:productTypes:`),
    clearKeyCaches(`${shop}:ProductFilterValues:`),
  ]);

  return { mirrorBatchId, reconciledProducts, reconciledVariants };
}

