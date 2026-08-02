import crypto from "crypto";
import { prisma } from "../config/database.js";
import { normalizeTargetSnapshotRow } from "../helpers/targetSnapshotFieldRegistry.js";

const TERMINAL_SET_STATUSES = new Set(["FROZEN", "FREEZE_FAILED", "EXPIRED", "CANCELLED", "CORRUPTED"]);

function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(input) {
  return crypto.createHash("sha256").update(String(input || "")).digest("hex");
}

export function buildSnapshotOperationId(operationType, operationRecordId) {
  const type = String(operationType || "").trim().toUpperCase();
  const recordId = String(operationRecordId || "").trim();
  if (!type || !recordId) throw new Error("SNAPSHOT_OPERATION_IDENTITY_REQUIRED");
  return `${type}:${recordId}`;
}

async function resolveSnapshotSet({
  shop,
  operationType,
  operationRecordId,
  mirrorBatchId = null,
  db,
}) {
  const operationId = buildSnapshotOperationId(operationType, operationRecordId);
  const direct = await db.targetSnapshotSet.findFirst({
    where: {
      shop,
      operationId,
      ...(mirrorBatchId ? { mirrorBatchId } : {}),
    },
  });
  if (direct || operationType !== "EDIT_HISTORY") return direct;

  const history = await db.editHistory.findFirst({
    where: { id: operationRecordId, shop },
    select: { snapshotSetId: true },
  });
  if (!history?.snapshotSetId) return null;
  return db.targetSnapshotSet.findFirst({
    where: {
      id: history.snapshotSetId,
      shop,
      ...(mirrorBatchId ? { mirrorBatchId } : {}),
    },
  });
}

async function ensureSnapshotSet({
  shop,
  operationType,
  operationRecordId,
  mirrorBatchId,
  targetDefinitionHash,
  db,
}) {
  const operationId = buildSnapshotOperationId(operationType, operationRecordId);
  const existing = await resolveSnapshotSet({
    shop,
    operationType,
    operationRecordId,
    mirrorBatchId,
    db,
  });
  if (existing) return existing;
  return db.targetSnapshotSet.create({
    data: {
      shop,
      operationId,
      mirrorBatchId,
      targetDefinitionHash: String(targetDefinitionHash || "").trim() || sha256(operationId),
      compilerVersion: "canonical-target-freeze-v1",
      projectionVersion: "canonical-target-item-v1",
      status: "FREEZING",
    },
  });
}

export async function deleteSnapshotItemsForOperation({
  shop,
  operationType,
  operationRecordId,
  db = prisma,
}) {
  const set = await resolveSnapshotSet({ shop, operationType, operationRecordId, db });
  if (!set) return { count: 0 };
  const result = await db.targetSnapshotItem.deleteMany({
    where: { shop, snapshotSetId: set.id },
  });
  await db.targetSnapshotSet.updateMany({
    where: { id: set.id, shop },
    data: {
      status: "FREEZING",
      targetCount: 0,
      productCount: 0,
      variantCount: 0,
      inventoryItemCount: 0,
      metafieldCount: 0,
      targetSetHash: null,
      frozenAt: null,
    },
  });
  return result;
}

export async function appendSnapshotItems({
  shop,
  operationType,
  operationRecordId,
  mirrorBatchId,
  targetDefinitionHash,
  rows,
  skipDuplicates = true,
  db = prisma,
}) {
  if (!Array.isArray(rows) || rows.length === 0) return { count: 0 };
  const set = await ensureSnapshotSet({
    shop,
    operationType,
    operationRecordId,
    mirrorBatchId,
    targetDefinitionHash,
    db,
  });
  const data = rows.map((row) => {
    const beforeValues = row.beforeValues && typeof row.beforeValues === "object"
      ? row.beforeValues
      : {};
    const plannedMutation = row.plannedMutation && typeof row.plannedMutation === "object"
      ? row.plannedMutation
      : beforeValues.plannedMutation && typeof beforeValues.plannedMutation === "object"
        ? beforeValues.plannedMutation
        : {};
    const normalized = normalizeTargetSnapshotRow({
      ...row,
      beforeValues,
      plannedMutation,
    });
    const { targetResourceType, targetKey, fieldPath } = normalized;
    const targetRowHash =
      String(row.targetRowHash || "").trim() || sha256(`${targetKey}:${fieldPath}`);
    return {
      snapshotSetId: set.id,
      shop,
      operationId: set.operationId,
      mirrorBatchId,
      productId: normalized.productId,
      variantId: normalized.variantId,
      collectionId: normalized.collectionId,
      inventoryItemId: normalized.inventoryItemId,
      locationId: normalized.locationId,
      productOptionPosition: normalized.productOptionPosition,
      metafieldOwnerId: normalized.metafieldOwnerId,
      metafieldOwnerType: normalized.metafieldOwnerType,
      metafieldNamespace: normalized.metafieldNamespace,
      metafieldKey: normalized.metafieldKey,
      targetKey,
      fieldPath,
      targetResourceType,
      targetGranularity: row.targetGranularity || null,
      ordinal: Number(row.ordinal || 0),
      mutationGroupKey:
        row.atomicMutationGroup === true
          ? String(row.mutationGroupKey || row.changeSource || row.source || targetRowHash)
          : null,
      beforeValues, // legacyRow.beforeValues.plannedMutation
      plannedMutation,
      beforeValueHash: normalized.beforeValueHash,
      plannedValueHash: normalized.plannedValueHash,
      writtenValueHash: normalized.writtenValueHash,
      sourceVersion: normalized.sourceVersion,
      sourceUpdatedAt: normalized.sourceUpdatedAt,
      targetRowHash,
      rowChecksum: String(row.rowChecksum || "").trim() || sha256(stableStringify({
        shop,
        operationId: set.operationId,
        mirrorBatchId,
        targetKey,
        fieldPath,
        targetResourceType,
        beforeValues,
        plannedMutation,
      })),
    };
  });
  const result = await db.targetSnapshotItem.createMany({ data, skipDuplicates });
  return result;
}

export async function freezeTargetSnapshotSet({
  shop,
  snapshotSetId,
  expectedRevision = 1,
  db = prisma,
}) {
  const freezeFn = async (tx) => {
    const set = await tx.targetSnapshotSet.findFirst({
      where: {
        shop,
        id: snapshotSetId,
        revision: expectedRevision,
        status: { in: ["FREEZING", "TARGET_FREEZING"] },
      },
    });

    if (!set) {
      const existing = await tx.targetSnapshotSet.findFirst({
        where: { shop, id: snapshotSetId },
      });
      if (existing && existing.status === "FROZEN") {
        return existing;
      }
      throw new Error("TARGET_SNAPSHOT_SET_NOT_FREEZING");
    }

    const itemCount = await tx.targetSnapshotItem.count({
      where: {
        shop,
        snapshotSetId,
        snapshotRevision: expectedRevision,
      },
    });

    const maximum = await tx.targetSnapshotItem.findFirst({
      where: {
        shop,
        snapshotSetId,
        snapshotRevision: expectedRevision,
      },
      orderBy: [
        { targetKey: "desc" },
        { fieldPath: "desc" },
      ],
      select: {
        targetKey: true,
        fieldPath: true,
      },
    });

    const terminalCursor = maximum ? encodeSnapshotItemCursor(maximum) : null;
    const frozenAt = new Date();

    await tx.targetSnapshotSet.updateMany({
      where: {
        shop,
        id: snapshotSetId,
        revision: expectedRevision,
        status: { in: ["FREEZING", "TARGET_FREEZING"] },
      },
      data: {
        status: "FROZEN",
        itemCount,
        terminalCursor,
        frozenAt,
      },
    });

    return tx.targetSnapshotSet.findFirst({
      where: { shop, id: snapshotSetId },
    });
  };

  if (db && db.$transaction === undefined) {
    return freezeFn(db);
  }

  return prisma.$transaction(freezeFn);
}

export async function finalizeSnapshotItemsForOperation({
  shop,
  operationType,
  operationRecordId,
  mirrorBatchId = null,
  targetDefinitionHash = null,
  db = prisma,
}) {
  let set = await resolveSnapshotSet({
    shop,
    operationType,
    operationRecordId,
    mirrorBatchId,
    db,
  });
  if (!set && mirrorBatchId) {
    set = await ensureSnapshotSet({
      shop,
      operationType,
      operationRecordId,
      mirrorBatchId,
      targetDefinitionHash,
      db,
    });
  }
  if (!set) throw new Error("TARGET_SNAPSHOT_SET_NOT_FOUND");
  await refreshTargetSnapshotSetCounters({ shop, snapshotSetId: set.id, db });
  return freezeTargetSnapshotSet({
    shop,
    snapshotSetId: set.id,
    expectedRevision: set.revision ?? 1,
    db,
  });
}

export async function countSnapshotItems({
  shop,
  operationType,
  operationRecordId,
  mirrorBatchId = null,
  targetResourceType = null,
  db = prisma,
}) {
  const set = await resolveSnapshotSet({
    shop,
    operationType,
    operationRecordId,
    mirrorBatchId,
    db,
  });
  if (!set) return 0;
  return db.targetSnapshotItem.count({
    where: {
      shop,
      snapshotSetId: set.id,
      ...(targetResourceType ? { targetResourceType } : {}),
    },
  });
}

export async function findSnapshotItems({
  shop,
  operationType,
  operationRecordId,
  mirrorBatchId = null,
  targetResourceType = null,
  targetKeys = null,
  productIdNotNull = false,
  afterOrdinal = null,
  take = undefined,
  distinctProductIds = false,
  db = prisma,
}) {
  const set = await resolveSnapshotSet({
    shop,
    operationType,
    operationRecordId,
    mirrorBatchId,
    db,
  });
  if (!set) return [];
  const rows = await db.targetSnapshotItem.findMany({
    where: {
      shop,
      snapshotSetId: set.id,
      ...(targetResourceType ? { targetResourceType } : {}),
      ...(Array.isArray(targetKeys) && targetKeys.length ? { targetKey: { in: targetKeys } } : {}),
      ...(productIdNotNull ? { productId: { not: null } } : {}),
      ...(afterOrdinal !== null ? { ordinal: { gt: afterOrdinal } } : {}),
    },
    orderBy: [{ ordinal: "asc" }, { id: "asc" }],
    ...(take !== undefined ? { take } : {}),
    ...(distinctProductIds ? { distinct: ["productId"] } : {}),
  });
  return rows.map((row) => ({
    ...row,
    targetIdentity: row.targetKey,
    normalizedFilterHash: set.targetDefinitionHash,
  }));
}

function buildRowChecksum({
  snapshotSetId,
  shop,
  operationId,
  mirrorBatchId,
  row,
  targetKey,
  compilerVersion,
  projectionVersion,
}) {
  return sha256(
    stableStringify({
      snapshotSetId,
      shop,
      operationId,
      mirrorBatchId,
      targetResourceType: String(row?.targetResourceType || "").toUpperCase(),
      targetKey,
      fieldPath: row?.fieldPath || null,
      productId: row?.productId || null,
      variantId: row?.variantId || null,
      beforeValues: row?.beforeValues || null,
      plannedMutation: row?.plannedMutation || {},
      beforeValueHash: row?.beforeValueHash || null,
      plannedValueHash: row?.plannedValueHash || null,
      targetRowHash: sha256(`${targetKey}:${row?.fieldPath || ""}`),
      compilerVersion,
      projectionVersion,
    }),
  );
}

function buildTargetSetHash({
  shop,
  operationId,
  previewContractId,
  mirrorBatchId,
  targetDefinitionHash,
  compilerVersion,
  projectionVersion,
  plannerVersion,
  targetCount,
  productCount,
  variantCount,
  inventoryItemCount,
  metafieldCount,
  productOptionCount,
  collectionMembershipCount,
  inventoryLevelCount,
  sortedRowChecksums,
}) {
  return sha256(
    stableStringify({
      shop,
      operationId,
      previewContractId,
      mirrorBatchId,
      targetDefinitionHash,
      compilerVersion,
      projectionVersion,
      plannerVersion: plannerVersion || null,
      targetCount,
      productCount,
      variantCount,
      inventoryItemCount,
      metafieldCount,
      productOptionCount,
      collectionMembershipCount,
      inventoryLevelCount,
      targetSetHashVersion: "sha256-stable-json-v2",
      rowChecksumAlgorithm: "sha256-stable-json-v1",
      sortedRowChecksums,
    }),
  );
}

export async function finalizeFrozenSnapshotSet({
  shop,
  historyId,
  operationId,
  previewContractId,
  mirrorBatchId,
  targetDefinitionHash,
  compilerVersion = "canonical-target-freeze-v1",
  projectionVersion = "canonical-target-item-v1",
  plannerVersion = null,
  source = "EDIT_HISTORY_FREEZE",
  db = prisma,
}) {
  const resolvedOperationId = String(operationId || "").trim() || `EDIT_HISTORY:${historyId}`;
  const resolvedPreviewContractId = String(previewContractId || "").trim() || `EDIT_HISTORY:${historyId}`;
  const resolvedMirrorBatchId = String(mirrorBatchId || "").trim();
  if (!resolvedMirrorBatchId) {
    throw new Error("TARGET_SNAPSHOT_SET_MIRROR_BATCH_REQUIRED");
  }

  const existing = await db.targetSnapshotSet.findFirst({
    where: { shop, operationId: resolvedOperationId },
    select: { id: true, status: true },
  });

  const set = existing
    ? await db.targetSnapshotSet.update({
      where: { shop_id: { shop, id: existing.id } },
      data: {
        mirrorBatchId: resolvedMirrorBatchId,
        targetDefinitionHash: String(targetDefinitionHash || "").trim() || sha256(`${shop}:${historyId}:${resolvedMirrorBatchId}`),
        compilerVersion,
        projectionVersion,
        plannerVersion: String(plannerVersion || "").trim() || null,
        status: "FREEZING",
        freezeErrorCode: null,
        freezeErrorMessage: null,
      },
    })
    : await db.targetSnapshotSet.create({
      data: {
        shop,
        operationId: resolvedOperationId,
        mirrorBatchId: resolvedMirrorBatchId,
        targetDefinitionHash: String(targetDefinitionHash || "").trim() || sha256(`${shop}:${historyId}:${resolvedMirrorBatchId}`),
        compilerVersion,
        projectionVersion,
        plannerVersion: String(plannerVersion || "").trim() || null,
        status: "FREEZING",
      },
    });

  try {
    const sourceSet = await resolveSnapshotSet({
      shop,
      operationType: "EDIT_HISTORY",
      operationRecordId: historyId,
      mirrorBatchId: resolvedMirrorBatchId,
      db,
    });
    const frozenRows = await findSnapshotItems({
      shop,
      operationType: "EDIT_HISTORY",
      operationRecordId: historyId,
      mirrorBatchId: resolvedMirrorBatchId,
      db,
    });

    await db.targetSnapshotItem.deleteMany({
      where: { shop, snapshotSetId: set.id },
    });

    const rows = [];
    const rowChecksums = [];
    let productCount = 0;
    let variantCount = 0;
    let inventoryItemCount = 0;
    let metafieldCount = 0;
    let productOptionCount = 0;
    let collectionMembershipCount = 0;
    let inventoryLevelCount = 0;
    let itemOrdinal = 0;

    for (const frozenRow of frozenRows) {
      const plannedMutation =
        frozenRow.plannedMutation &&
        typeof frozenRow.plannedMutation === "object"
          ? frozenRow.plannedMutation
          : frozenRow.beforeValues &&
            typeof frozenRow.beforeValues === "object" &&
            !Array.isArray(frozenRow.beforeValues) &&
            frozenRow.beforeValues.plannedMutation &&
            typeof frozenRow.beforeValues.plannedMutation === "object"
          ? frozenRow.beforeValues.plannedMutation
          : {};
      const normalized = normalizeTargetSnapshotRow({
        ...frozenRow,
        plannedMutation,
        atomicMutationGroup: Boolean(frozenRow.mutationGroupKey),
      });
      const { targetResourceType, targetKey, fieldPath } = normalized;
      const rowChecksum = buildRowChecksum({
        snapshotSetId: set.id,
        shop,
        operationId: resolvedOperationId,
        mirrorBatchId: resolvedMirrorBatchId,
        row: {
          ...frozenRow,
          ...normalized,
          plannedMutation,
        },
        targetKey,
        compilerVersion,
        projectionVersion,
      });
      rowChecksums.push(rowChecksum);
      if (targetResourceType === "PRODUCT") productCount += 1;
      if (targetResourceType === "VARIANT") variantCount += 1;
      if (targetResourceType === "INVENTORY_ITEM") inventoryItemCount += 1;
      if (targetResourceType === "METAFIELD") metafieldCount += 1;
      if (targetResourceType === "PRODUCT_OPTION") productOptionCount += 1;
      if (targetResourceType === "COLLECTION_MEMBERSHIP") collectionMembershipCount += 1;
      if (targetResourceType === "INVENTORY_LEVEL") inventoryLevelCount += 1;
      rows.push({
        snapshotSetId: set.id,
        shop,
        operationId: resolvedOperationId,
        mirrorBatchId: resolvedMirrorBatchId,
        productId: normalized.productId,
        variantId: normalized.variantId,
        collectionId: normalized.collectionId,
        inventoryItemId: normalized.inventoryItemId,
        locationId: normalized.locationId,
        productOptionPosition: normalized.productOptionPosition,
        metafieldOwnerId: normalized.metafieldOwnerId,
        metafieldOwnerType: normalized.metafieldOwnerType,
        metafieldNamespace: normalized.metafieldNamespace,
        metafieldKey: normalized.metafieldKey,
        targetKey,
        fieldPath,
        targetResourceType,
        targetGranularity: frozenRow.targetGranularity || null,
        ordinal: Number.isInteger(frozenRow.ordinal) ? frozenRow.ordinal : itemOrdinal,
        mutationGroupKey: source,
        beforeValues: frozenRow.beforeValues || {},
        plannedMutation,
        beforeValueHash: normalized.beforeValueHash,
        plannedValueHash: normalized.plannedValueHash,
        writtenValueHash: normalized.writtenValueHash,
        sourceVersion: normalized.sourceVersion,
        sourceUpdatedAt: normalized.sourceUpdatedAt,
        targetRowHash: sha256(`${targetKey}:${fieldPath}`),
        rowChecksum,
      });
      itemOrdinal += 1;
    }

    const CHUNK = 1000;
    for (let i = 0; i < rows.length; i += CHUNK) {
      // eslint-disable-next-line no-await-in-loop
      await db.targetSnapshotItem.createMany({
        data: rows.slice(i, i + CHUNK),
      });
    }

    const targetCount = rows.length;
    const sortedRowChecksums = [...rowChecksums].sort();
    const targetSetHash = buildTargetSetHash({
      shop,
      operationId: resolvedOperationId,
      previewContractId: resolvedPreviewContractId,
      mirrorBatchId: resolvedMirrorBatchId,
      targetDefinitionHash: set.targetDefinitionHash,
      compilerVersion,
      projectionVersion,
      plannerVersion: set.plannerVersion || plannerVersion || null,
      targetCount,
      productCount,
      variantCount,
      inventoryItemCount,
      metafieldCount,
      productOptionCount,
      collectionMembershipCount,
      inventoryLevelCount,
      sortedRowChecksums,
    });

    const freezeFinalizeResult = await db.targetSnapshotSet.updateMany({
      where: {
        id: set.id,
        shop,
        status: "FREEZING",
      },
      data: {
        status: "FROZEN",
        targetSetHash,
        targetCount,
        productCount,
        variantCount,
        inventoryItemCount,
        metafieldCount,
        productOptionCount,
        collectionMembershipCount,
        inventoryLevelCount,
        mutationPendingCount: targetCount,
        mutationSubmittedCount: 0,
        mutationSucceededCount: 0,
        mutationFailedCount: 0,
        mutationSkippedCount: 0,
        verificationPendingCount: 0,
        verificationSucceededCount: 0,
        verificationFailedCount: 0,
        undoNotRequiredCount: targetCount,
        undoPendingCount: 0,
        undoSubmittedCount: 0,
        undoSucceededCount: 0,
        undoFailedCount: 0,
        undoSkippedCount: 0,
        frozenAt: new Date(),
        failedAt: null,
      },
    });
    if (Number(freezeFinalizeResult?.count || 0) !== 1) {
      const error = new Error("Snapshot finalization conflict");
      error.code = "SNAPSHOT_FINALIZATION_CONFLICT";
      throw error;
    }
    const frozenSet = await db.targetSnapshotSet.findUnique({
      where: { shop_id: { shop, id: set.id } },
    });
    if (!frozenSet || frozenSet.status !== "FROZEN") {
      throw new Error("TARGET_SNAPSHOT_SET_FREEZE_FINALIZE_MISSING");
    }

    if (sourceSet && sourceSet.id !== set.id) {
      await db.targetSnapshotSet.deleteMany({
        where: { id: sourceSet.id, shop },
      });
    }

    return frozenSet;
  } catch (error) {
    await db.targetSnapshotSet.updateMany({
      where: {
        id: set.id,
        shop,
        status: "FREEZING",
      },
      data: {
        status: "FREEZE_FAILED",
        failedAt: new Date(),
        freezeErrorCode: String(error?.code || "FREEZE_FAILED"),
        freezeErrorMessage: String(error?.message || "Failed to materialize target snapshot set"),
      },
    });
    throw error;
  }
}

export async function getFrozenSnapshotSetForExecution({
  shop,
  snapshotSetId,
  operationId,
  db = prisma,
}) {
  const where = {
    shop,
    status: "FROZEN",
    ...(snapshotSetId ? { id: snapshotSetId } : {}),
    ...(operationId ? { operationId } : {}),
  };

  const set = await db.targetSnapshotSet.findFirst({ where });
  if (!set) {
    throw new Error("FROZEN_TARGET_SNAPSHOT_SET_NOT_FOUND");
  }
  const itemCount = await db.targetSnapshotItem.count({
    where: { shop, snapshotSetId: set.id },
  });
  const expectedCount = Number(set.targetCount || 0);
  if (expectedCount !== Number(itemCount || 0)) {
    await db.targetSnapshotSet.updateMany({
      where: { id: set.id, shop, status: "FROZEN" },
      data: {
        status: "CORRUPTED",
        freezeErrorCode: "SNAPSHOT_COUNT_MISMATCH",
        freezeErrorMessage: `Expected ${expectedCount} rows but found ${Number(itemCount || 0)}`,
      },
    });
    throw new Error("SNAPSHOT_SET_CORRUPTED");
  }
  if (!set.targetSetHash) {
    await db.targetSnapshotSet.updateMany({
      where: { id: set.id, shop, status: "FROZEN" },
      data: {
        status: "CORRUPTED",
        freezeErrorCode: "SNAPSHOT_CHECKSUM_MISSING",
        freezeErrorMessage: "Frozen target-set hash missing",
      },
    });
    throw new Error("FROZEN_TARGET_SNAPSHOT_SET_CHECKSUM_MISSING");
  }
  if (!Number.isFinite(Number(set.targetCount)) || Number(set.targetCount) <= 0) {
    throw new Error("FROZEN_TARGET_SNAPSHOT_SET_EMPTY");
  }
  if (set.expiresAt && new Date(set.expiresAt).getTime() <= Date.now()) {
    throw new Error("FROZEN_TARGET_SNAPSHOT_SET_EXPIRED");
  }
  return set;
}

/**
 * Rebuilds the three independent counter families from item state in one
 * PostgreSQL statement. Call at bounded workflow checkpoints, not per item.
 */
export async function refreshTargetSnapshotSetCounters({
  shop,
  snapshotSetId,
  db = prisma,
}) {
  if (!shop || !snapshotSetId) {
    throw new Error("TARGET_SNAPSHOT_SET_COUNTER_SCOPE_REQUIRED");
  }

  await db.$executeRaw`
    WITH counts AS (
      SELECT
        COUNT(*)::integer AS "targetCount",
        COUNT(*) FILTER (WHERE item."targetType" = 'PRODUCT')::integer AS "productCount",
        COUNT(*) FILTER (WHERE item."targetType" = 'VARIANT')::integer AS "variantCount",
        COUNT(*) FILTER (WHERE item."targetType" = 'INVENTORY_ITEM')::integer AS "inventoryItemCount",
        COUNT(*) FILTER (WHERE item."targetType" = 'METAFIELD')::integer AS "metafieldCount",
        COUNT(*) FILTER (WHERE item."targetType" = 'PRODUCT_OPTION')::integer AS "productOptionCount",
        COUNT(*) FILTER (WHERE item."targetType" = 'COLLECTION_MEMBERSHIP')::integer AS "collectionMembershipCount",
        COUNT(*) FILTER (WHERE item."targetType" = 'INVENTORY_LEVEL')::integer AS "inventoryLevelCount",
        COUNT(*) FILTER (WHERE item."executionStatus" IN ('PENDING', 'DEFERRED'))::integer AS "mutationPendingCount",
        COUNT(*) FILTER (WHERE item."executionStatus" = 'SUBMITTED')::integer AS "mutationSubmittedCount",
        COUNT(*) FILTER (WHERE item."executionStatus" = 'SUCCEEDED')::integer AS "mutationSucceededCount",
        COUNT(*) FILTER (WHERE item."executionStatus" = 'FAILED')::integer AS "mutationFailedCount",
        COUNT(*) FILTER (WHERE item."executionStatus" IN ('SKIPPED', 'CANCELLED'))::integer AS "mutationSkippedCount",
        COUNT(*) FILTER (WHERE item."verificationStatus" = 'PENDING')::integer AS "verificationPendingCount",
        COUNT(*) FILTER (WHERE item."verificationStatus" = 'SUCCEEDED')::integer AS "verificationSucceededCount",
        COUNT(*) FILTER (WHERE item."verificationStatus" = 'FAILED')::integer AS "verificationFailedCount",
        COUNT(*) FILTER (WHERE item."undoStatus" = 'NOT_REQUIRED')::integer AS "undoNotRequiredCount",
        COUNT(*) FILTER (WHERE item."undoStatus" = 'PENDING')::integer AS "undoPendingCount",
        COUNT(*) FILTER (WHERE item."undoStatus" = 'SUBMITTED')::integer AS "undoSubmittedCount",
        COUNT(*) FILTER (WHERE item."undoStatus" = 'SUCCEEDED')::integer AS "undoSucceededCount",
        COUNT(*) FILTER (WHERE item."undoStatus" = 'FAILED')::integer AS "undoFailedCount",
        COUNT(*) FILTER (WHERE item."undoStatus" = 'SKIPPED')::integer AS "undoSkippedCount"
      FROM "TargetSnapshotItem" item
      WHERE item."shop" = ${shop} AND item."snapshotSetId" = ${snapshotSetId}
    )
    UPDATE "TargetSnapshotSet" setrow
    SET "targetCount" = counts."targetCount",
        "productCount" = counts."productCount",
        "variantCount" = counts."variantCount",
        "inventoryItemCount" = counts."inventoryItemCount",
        "metafieldCount" = counts."metafieldCount",
        "productOptionCount" = counts."productOptionCount",
        "collectionMembershipCount" = counts."collectionMembershipCount",
        "inventoryLevelCount" = counts."inventoryLevelCount",
        "pendingCount" = counts."mutationPendingCount",
        "submittedCount" = counts."mutationSubmittedCount",
        "succeededCount" = counts."mutationSucceededCount",
        "failedCount" = counts."mutationFailedCount",
        "skippedCount" = counts."mutationSkippedCount",
        "verificationPendingCount" = counts."verificationPendingCount",
        "verifiedCount" = counts."verificationSucceededCount",
        "verificationFailedCount" = counts."verificationFailedCount",
        "undoNotRequiredCount" = counts."undoNotRequiredCount",
        "undoPendingCount" = counts."undoPendingCount",
        "undoSubmittedCount" = counts."undoSubmittedCount",
        "undoSucceededCount" = counts."undoSucceededCount",
        "undoFailedCount" = counts."undoFailedCount",
        "undoSkippedCount" = counts."undoSkippedCount"
    FROM counts
    WHERE setrow."shop" = ${shop} AND setrow."id" = ${snapshotSetId}
  `;

  return db.targetSnapshotSet.findFirst({
    where: { id: snapshotSetId, shop },
  });
}

function buildRepositoryError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

export function encodeSnapshotItemCursor({
  shop = "",
  snapshotSetId = "",
  snapshotRevision = 1,
  targetKey,
  fieldPath = "",
}) {
  const key = String(targetKey || "").trim();
  if (!key) return null;
  const payload = {
    version: 1,
    shop: String(shop || "").trim(),
    snapshotSetId: String(snapshotSetId || "").trim(),
    snapshotRevision: Number(snapshotRevision || 1),
    targetKey: key,
    fieldPath: String(fieldPath || "").trim(),
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeSnapshotItemCursor(cursorValue) {
  if (!cursorValue || typeof cursorValue !== "string") return null;
  try {
    const raw = Buffer.from(cursorValue, "base64url").toString("utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && obj.targetKey) {
      return {
        version: obj.version || 1,
        shop: String(obj.shop || ""),
        snapshotSetId: String(obj.snapshotSetId || ""),
        snapshotRevision: Number(obj.snapshotRevision || 1),
        targetKey: String(obj.targetKey || ""),
        fieldPath: String(obj.fieldPath || ""),
      };
    }
  } catch {
    const value = String(cursorValue || "").trim();
    const separator = value.indexOf("\u001f");
    if (separator >= 0) {
      return {
        version: 1,
        shop: "",
        snapshotSetId: "",
        snapshotRevision: 1,
        targetKey: value.slice(0, separator),
        fieldPath: value.slice(separator + 1),
      };
    }
    return {
      version: 1,
      shop: "",
      snapshotSetId: "",
      snapshotRevision: 1,
      targetKey: value,
      fieldPath: "",
    };
  }
  return null;
}

export function validateSnapshotCursorScope(
  cursor,
  { shop, snapshotSetId, snapshotRevision = 1 }
) {
  if (!cursor) return;

  if (
    (cursor.shop && cursor.shop !== shop) ||
    (cursor.snapshotSetId && cursor.snapshotSetId !== snapshotSetId) ||
    (cursor.snapshotRevision && cursor.snapshotRevision !== snapshotRevision)
  ) {
    throw buildRepositoryError("SNAPSHOT_CURSOR_SCOPE_MISMATCH");
  }
}

export function buildAfterCursorPredicate(cursor) {
  if (!cursor) return {};

  return {
    OR: [
      {
        targetKey: {
          gt: cursor.targetKey,
        },
      },
      {
        targetKey: cursor.targetKey,
        fieldPath: {
          gt: cursor.fieldPath,
        },
      },
    ],
  };
}

export async function findFrozenSnapshotBoundary({
  snapshotSetId,
  shop,
  expectedRevision = 1,
  tx = prisma,
}) {
  return tx.targetSnapshotSet.findFirst({
    where: {
      id: snapshotSetId,
      shop,
      revision: expectedRevision,
      status: "FROZEN",
    },
    select: {
      itemCount: true,
      terminalCursor: true,
      revision: true,
    },
  });
}

export async function listFrozenSnapshotItemsPage({
  shop,
  snapshotSetId,
  snapshotRevision = 1,
  cursorValue = null,
  cursorTargetKey = null,
  lastTargetKey = null,
  limit = 1000,
  targetResourceType = null,
  targetKeys = null,
  executionStatus = null,
  undoStatus = null,
  db = prisma,
}) {
  const rawCursor = cursorValue || cursorTargetKey || lastTargetKey || null;
  const decodedCursor = decodeSnapshotItemCursor(rawCursor);
  if (decodedCursor && decodedCursor.shop && decodedCursor.snapshotSetId) {
    validateSnapshotCursorScope(decodedCursor, {
      shop,
      snapshotSetId,
      snapshotRevision,
    });
  }

  const cursorPredicate = buildAfterCursorPredicate(decodedCursor);

  const where = {
    shop,
    snapshotSetId,
    snapshotRevision,
    ...(Array.isArray(targetResourceType)
      ? { targetResourceType: { in: targetResourceType } }
      : targetResourceType
        ? { targetResourceType }
        : {}),
    ...(Array.isArray(targetKeys) && targetKeys.length > 0 ? { targetKey: { in: targetKeys } } : {}),
    ...(executionStatus ? { executionStatus } : {}),
    ...(undoStatus ? { undoStatus } : {}),
    ...cursorPredicate,
  };

  const rows = await db.targetSnapshotItem.findMany({
    where,
    orderBy: [{ targetKey: "asc" }, { fieldPath: "asc" }],
    take: limit + 1,
    select: {
      id: true,
      productId: true,
      variantId: true,
      targetResourceType: true,
      targetKey: true,
      fieldPath: true,
      beforeValues: true,
      plannedMutation: true,
      rowChecksum: true,
      executionStatus: true,
      undoStatus: true,
    },
  });

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = pageRows.length
    ? encodeSnapshotItemCursor({
        shop,
        snapshotSetId,
        snapshotRevision,
        targetKey: pageRows[pageRows.length - 1].targetKey,
        fieldPath: pageRows[pageRows.length - 1].fieldPath,
      })
    : null;

  return {
    rows: pageRows,
    hasMore,
    cursorValue: nextCursor,
    cursorTargetKey: nextCursor,
  };
}

export function isTerminalSnapshotSetStatus(status) {
  return TERMINAL_SET_STATUSES.has(String(status || "").toUpperCase());
}
