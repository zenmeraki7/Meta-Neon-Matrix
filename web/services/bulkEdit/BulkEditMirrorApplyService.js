import { db } from "../../repositories/repositoryDb.js";
import { assertSnapshotItemsFullyIngested } from "../targetSnapshotItemIntegrityService.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";

const MAX_SET_BASED_ROWS = 500;

function assertBoundedRows(label, size) {
  if (size > MAX_SET_BASED_ROWS) {
    throw new Error(`${label} exceeds the ${MAX_SET_BASED_ROWS}-row transaction bound`);
  }
}

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
        targetProductMirrorBatchId: true,
      },
    }),
    db.store.findUnique({
      where: { shopUrl: shop },
      select: { currentProductMirrorBatchId: true },
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
    store?.currentProductMirrorBatchId || history?.targetProductMirrorBatchId || "",
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
      fieldPath: true,
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

  const targetFields = [...new Map(
    rows
      .map((row) => ({
        targetKey: String(row?.targetIdentity || "").trim(),
        fieldPath: String(row?.fieldPath || "").trim(),
      }))
      .filter((row) => row.targetKey && row.fieldPath)
      .map((row) => [`${row.targetKey}\u001f${row.fieldPath}`, row]),
  ).values()];
  const snapshotRows = targetFields.length
    ? await db.targetSnapshotItem.findMany({
        where: {
          shop,
          snapshotSetId,
          OR: targetFields,
          executionStatus: "SUCCEEDED",
        },
        select: {
          id: true,
          targetKey: true,
          fieldPath: true,
          plannedMutation: true,
          beforeValues: true,
        },
      })
    : [];
  assertBoundedRows("Bulk mirror change batch", rows.length);
  assertSnapshotItemsFullyIngested(snapshotRows, "mirror_apply");
  const snapshotTargetFields = new Set(
    snapshotRows.map((row) => `${row.targetKey}\u001f${row.fieldPath}`),
  );
  const missingTargetField = targetFields.find(
    (row) => !snapshotTargetFields.has(`${row.targetKey}\u001f${row.fieldPath}`),
  );
  if (missingTargetField) {
    const error = new Error("MIRROR_APPLY_TRUSTED_SNAPSHOT_FIELD_REQUIRED");
    error.code = "MIRROR_APPLY_TRUSTED_SNAPSHOT_FIELD_REQUIRED";
    error.details = missingTargetField;
    throw error;
  }

  const productUpdates = new Map();
  const variantUpdates = new Map();
  for (const row of rows) {
    const { productPatch, variantPatches } = buildMirrorPatches(row);
    if (Object.keys(productPatch).length > 0 && row.productId) {
      const id = String(row.productId);
      productUpdates.set(id, { ...(productUpdates.get(id) || {}), ...productPatch });
    }
    for (const [variantId, variantPatch] of variantPatches.entries()) {
      variantUpdates.set(variantId, { ...(variantUpdates.get(variantId) || {}), ...variantPatch });
    }
  }

  const [existingProducts, existingVariants] = await Promise.all([
    productUpdates.size
      ? db.product.findMany({
          where: { shop, mirrorBatchId, id: { in: [...productUpdates.keys()] } },
          select: { id: true },
        })
      : [],
    variantUpdates.size
      ? db.variant.findMany({
          where: { shop, mirrorBatchId, id: { in: [...variantUpdates.keys()] } },
          select: { id: true },
        })
      : [],
  ]);
  const existingProductIds = new Set(existingProducts.map((row) => row.id));
  const existingVariantIds = new Set(existingVariants.map((row) => row.id));
  const changeUpdates = [];

  for (const row of rows) {
    const { productPatch, variantPatches } = buildMirrorPatches(row);
    const rowApplied =
      (Object.keys(productPatch).length > 0 && existingProductIds.has(String(row.productId))) ||
      [...variantPatches.keys()].some((id) => existingVariantIds.has(id));

    const previousOptions =
      row.options && typeof row.options === "object" && !Array.isArray(row.options)
        ? row.options
        : {};

    changeUpdates.push({
      id: row.id,
      options: {
        ...previousOptions,
        mirrorApplyStatus: rowApplied ? "APPLIED_PENDING_RECONCILE" : "UNRESOLVED",
        mirrorAppliedAt: rowApplied ? new Date().toISOString() : null,
        mirrorBatchId,
      },
    });

    if (rowApplied) appliedRows += 1;
    else unresolvedRows += 1;
  }

  const now = new Date();
  await db.$transaction(async (tx) => {
    if (productUpdates.size > 0) {
      const updates = [...productUpdates].map(([id, patch]) => ({ id, patch }));
      await tx.$executeRaw`
        UPDATE "Product" product SET
          "title" = CASE WHEN row.patch ? 'title' THEN row.patch->>'title' ELSE product."title" END,
          "status" = CASE WHEN row.patch ? 'status' THEN row.patch->>'status' ELSE product."status" END,
          "vendor" = CASE WHEN row.patch ? 'vendor' THEN row.patch->>'vendor' ELSE product."vendor" END,
          "productType" = CASE WHEN row.patch ? 'productType' THEN row.patch->>'productType' ELSE product."productType" END,
          "handle" = CASE WHEN row.patch ? 'handle' THEN row.patch->>'handle' ELSE product."handle" END,
          "templateSuffix" = CASE WHEN row.patch ? 'templateSuffix' THEN row.patch->>'templateSuffix' ELSE product."templateSuffix" END,
          "descriptionHtml" = CASE WHEN row.patch ? 'descriptionHtml' THEN row.patch->>'descriptionHtml' ELSE product."descriptionHtml" END,
          "seoTitle" = CASE WHEN row.patch ? 'seoTitle' THEN row.patch->>'seoTitle' ELSE product."seoTitle" END,
          "seoDescription" = CASE WHEN row.patch ? 'seoDescription' THEN row.patch->>'seoDescription' ELSE product."seoDescription" END,
          "tags" = CASE WHEN row.patch ? 'tags' THEN ARRAY(SELECT jsonb_array_elements_text(row.patch->'tags')) ELSE product."tags" END,
          "lastSourceKind" = 'BULK_EDIT_VERIFICATION',
          "lastReconciledAt" = ${now},
          "updatedAt" = ${now}
        FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) AS row(id text, patch jsonb)
        WHERE product."shop" = ${shop} AND product."mirrorBatchId" = ${mirrorBatchId} AND product."id" = row.id
      `;
    }
    if (variantUpdates.size > 0) {
      const updates = [...variantUpdates].map(([id, patch]) => ({ id, patch }));
      await tx.$executeRaw`
        UPDATE "Variant" variant SET
          "sku" = CASE WHEN row.patch ? 'sku' THEN row.patch->>'sku' ELSE variant."sku" END,
          "barcode" = CASE WHEN row.patch ? 'barcode' THEN row.patch->>'barcode' ELSE variant."barcode" END,
          "taxCode" = CASE WHEN row.patch ? 'taxCode' THEN row.patch->>'taxCode' ELSE variant."taxCode" END,
          "inventoryPolicy" = CASE WHEN row.patch ? 'inventoryPolicy' THEN row.patch->>'inventoryPolicy' ELSE variant."inventoryPolicy" END,
          "weightUnit" = CASE WHEN row.patch ? 'weightUnit' THEN row.patch->>'weightUnit' ELSE variant."weightUnit" END,
          "option1Value" = CASE WHEN row.patch ? 'option1Value' THEN row.patch->>'option1Value' ELSE variant."option1Value" END,
          "option2Value" = CASE WHEN row.patch ? 'option2Value' THEN row.patch->>'option2Value' ELSE variant."option2Value" END,
          "option3Value" = CASE WHEN row.patch ? 'option3Value' THEN row.patch->>'option3Value' ELSE variant."option3Value" END,
          "price" = CASE WHEN row.patch ? 'price' THEN (row.patch->>'price')::numeric ELSE variant."price" END,
          "compareAtPrice" = CASE WHEN row.patch ? 'compareAtPrice' THEN (row.patch->>'compareAtPrice')::numeric ELSE variant."compareAtPrice" END,
          "cost" = CASE WHEN row.patch ? 'cost' THEN (row.patch->>'cost')::numeric ELSE variant."cost" END,
          "weight" = CASE WHEN row.patch ? 'weight' THEN (row.patch->>'weight')::numeric ELSE variant."weight" END,
          "inventoryQuantity" = CASE WHEN row.patch ? 'inventoryQuantity' THEN (row.patch->>'inventoryQuantity')::integer ELSE variant."inventoryQuantity" END,
          "taxable" = CASE WHEN row.patch ? 'taxable' THEN (row.patch->>'taxable')::boolean ELSE variant."taxable" END,
          "tracked" = CASE WHEN row.patch ? 'tracked' THEN (row.patch->>'tracked')::boolean ELSE variant."tracked" END,
          "physicalProduct" = CASE WHEN row.patch ? 'physicalProduct' THEN (row.patch->>'physicalProduct')::boolean ELSE variant."physicalProduct" END,
          "lastChangeSource" = 'BULK_EDIT_VERIFICATION',
          "reconciliationCompletedAt" = ${now},
          "updatedAt" = ${now}
        FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) AS row(id text, patch jsonb)
        WHERE variant."shop" = ${shop} AND variant."mirrorBatchId" = ${mirrorBatchId} AND variant."id" = row.id
      `;
    }
    if (changeUpdates.length > 0) {
      await tx.$executeRaw`
        UPDATE "ChangeRecord" change SET "options" = row.options, "updatedAt" = ${now}
        FROM jsonb_to_recordset(${JSON.stringify(changeUpdates)}::jsonb) AS row(id text, options jsonb)
        WHERE change."shop" = ${shop} AND change."id" = row.id
      `;
    }
  });

  appliedProductRows = existingProductIds.size;
  appliedVariantRows = existingVariantIds.size;

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
    reconciliationCompletedAt: new Date(),
    lastChangeSource: "BULK_EDIT_VERIFICATION",
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
    select: { currentProductMirrorBatchId: true },
  });
  const mirrorBatchId = String(store?.currentProductMirrorBatchId || "").trim();
  if (!mirrorBatchId) throw new Error("VERIFIED_MIRROR_ACTIVE_BATCH_REQUIRED");

  const productRows = [];
  const variantRows = [];
  for (const [productId, product] of productsById.entries()) {
    if (!productId || product?.__typename !== "Product") continue;
    const embeddedVariants = Array.isArray(product?.variants?.nodes)
      ? product.variants.nodes
      : [];

    const productData = productDataFromShopify(product);
    productRows.push({
      id: productId,
      ...productData,
      updatedAt: (productData.updatedAt || new Date()).toISOString(),
      reconciliationCompletedAt: productData.reconciliationCompletedAt.toISOString(),
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
      variantRows.push({ id: variantId, ...variantDataFromShopify(variant, productId) });
    }
  }

  const reconciledProducts = productRows.length;
  const reconciledVariants = variantRows.length;
  assertBoundedRows("Verified product reconciliation", reconciledProducts);
  assertBoundedRows("Verified variant reconciliation", reconciledVariants);
  if (reconciledProducts > 0) {
    const now = new Date();
    await db.$transaction(async (tx) => {
      const currentStore = await tx.store.findUnique({
        where: { shopUrl: shop },
        select: { currentProductMirrorBatchId: true },
      });
      const activeBatchId = String(currentStore?.currentProductMirrorBatchId || "").trim();
      if (!activeBatchId || activeBatchId !== mirrorBatchId) {
        throw new Error("VERIFIED_MIRROR_ACTIVE_BATCH_CHANGED");
      }

      await tx.$executeRaw`
        INSERT INTO "Product" (
          "shop", "id", "mirrorBatchId", "title", "handle", "status", "statusNormalized",
          "vendor", "productType", "tags", "descriptionHtml", "descriptionText",
          "seoTitle", "seoDescription", "reconciliationCompletedAt", "lastChangeSource", "createdAt", "updatedAt"
        )
        SELECT ${shop}, row."id", ${activeBatchId}, row."title", row."handle", row."status",
               row."statusNormalized", row."vendor", row."productType",
               row."tags", row."descriptionHtml", row."descriptionText", row."seoTitle",
               row."seoDescription", row."reconciliationCompletedAt"::timestamp, row."lastChangeSource", ${now}, row."updatedAt"::timestamp
        FROM jsonb_to_recordset(${JSON.stringify(productRows)}::jsonb) AS row(
          "id" text, "title" text, "handle" text, "status" text, "statusNormalized" text,
          "vendor" text, "productType" text, "tags" text[], "descriptionHtml" text,
          "descriptionText" text, "seoTitle" text, "seoDescription" text,
          "reconciliationCompletedAt" text, "lastChangeSource" text, "updatedAt" text
        )
        ON CONFLICT ("shop", "id", "mirrorBatchId") DO UPDATE SET
          "title" = EXCLUDED."title", "handle" = EXCLUDED."handle", "status" = EXCLUDED."status",
          "statusNormalized" = EXCLUDED."statusNormalized", "vendor" = EXCLUDED."vendor",
          "productType" = EXCLUDED."productType", "tags" = EXCLUDED."tags",
          "descriptionHtml" = EXCLUDED."descriptionHtml", "descriptionText" = EXCLUDED."descriptionText",
          "seoTitle" = EXCLUDED."seoTitle", "seoDescription" = EXCLUDED."seoDescription",
          "reconciliationCompletedAt" = EXCLUDED."reconciliationCompletedAt", "lastChangeSource" = EXCLUDED."lastChangeSource",
          "updatedAt" = EXCLUDED."updatedAt"
      `;

      if (variantRows.length > 0) {
        await tx.$executeRaw`
          INSERT INTO "Variant" (
            "shop", "id", "mirrorBatchId", "productId", "title", "sku", "barcode", "price",
            "compareAtPrice", "inventoryQuantity", "taxable", "selectedOptionsJson",
            "option1Value", "option2Value", "option3Value", "createdAt", "updatedAt"
          )
          SELECT ${shop}, row."id", ${activeBatchId}, row."productId", row."title", row."sku", row."barcode",
                 row."price"::numeric, row."compareAtPrice"::numeric, row."inventoryQuantity",
                 row."taxable", row."selectedOptionsJson", row."option1Value", row."option2Value", row."option3Value", ${now}, ${now}
          FROM jsonb_to_recordset(${JSON.stringify(variantRows)}::jsonb) AS row(
            "id" text, "productId" text, "title" text, "sku" text, "barcode" text, "price" text,
            "compareAtPrice" text, "inventoryQuantity" integer, "taxable" boolean,
            "selectedOptionsJson" jsonb, "option1Value" text, "option2Value" text, "option3Value" text
          )
          ON CONFLICT ("shop", "id", "mirrorBatchId") DO UPDATE SET
            "productId" = EXCLUDED."productId", "title" = EXCLUDED."title", "sku" = EXCLUDED."sku",
            "barcode" = EXCLUDED."barcode", "price" = EXCLUDED."price", "compareAtPrice" = EXCLUDED."compareAtPrice",
            "inventoryQuantity" = EXCLUDED."inventoryQuantity", "taxable" = EXCLUDED."taxable",
            "selectedOptionsJson" = EXCLUDED."selectedOptionsJson", "option1Value" = EXCLUDED."option1Value",
            "option2Value" = EXCLUDED."option2Value", "option3Value" = EXCLUDED."option3Value", "updatedAt" = EXCLUDED."updatedAt"
        `;
      }

      await tx.$executeRaw`
        UPDATE "Product" product
        SET "totalInventory" = aggregate."totalInventory", "variantCount" = aggregate."variantCount", "updatedAt" = ${now}
        FROM (
          SELECT "productId", SUM("inventoryQuantity")::integer AS "totalInventory", COUNT(*)::integer AS "variantCount"
          FROM "Variant"
          WHERE "shop" = ${shop} AND "mirrorBatchId" = ${activeBatchId}
            AND "productId" = ANY(${productRows.map((row) => row.id)}::text[])
          GROUP BY "productId"
        ) aggregate
        WHERE product."shop" = ${shop} AND product."mirrorBatchId" = ${activeBatchId}
          AND product."id" = aggregate."productId"
      `;
    });
  }

  await Promise.all([
    clearKeyCaches(`${shop}:ProductFetch:`),
    clearKeyCaches(`${shop}:productTypes:`),
    clearKeyCaches(`${shop}:ProductFilterValues:`),
  ]);

  return { mirrorBatchId, reconciledProducts, reconciledVariants };
}
