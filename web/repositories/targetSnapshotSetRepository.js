import crypto from "crypto";
import { prisma } from "../config/database.js";

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
      previewContractId: operationId,
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
    const targetResourceType = String(row.targetResourceType || "").toUpperCase();
    const targetKey = String(row.targetKey || row.targetIdentity || "").trim();
    const beforeValues = row.beforeValues && typeof row.beforeValues === "object"
      ? row.beforeValues
      : {};
    const plannedMutation = row.plannedMutation && typeof row.plannedMutation === "object"
      ? row.plannedMutation
      : beforeValues.plannedMutation && typeof beforeValues.plannedMutation === "object"
        ? beforeValues.plannedMutation
        : {};
    const targetRowHash = String(row.targetRowHash || "").trim() || sha256(targetKey);
    return {
      snapshotSetId: set.id,
      shop,
      operationId: set.operationId,
      mirrorBatchId,
      productId: row.productId ? String(row.productId).trim() : null,
      variantId: row.variantId ? String(row.variantId).trim() : null,
      collectionId: row.collectionId ? String(row.collectionId).trim() : null,
      inventoryItemId: row.inventoryItemId ? String(row.inventoryItemId).trim() : null,
      locationId: row.locationId ? String(row.locationId).trim() : null,
      targetKey,
      targetResourceType,
      targetGranularity: row.targetGranularity || null,
      ordinal: Number(row.ordinal || 0),
      mutationGroupKey: row.changeSource || row.source || null,
      beforeValues,
      plannedMutation,
      targetRowHash,
      rowChecksum: String(row.rowChecksum || "").trim() || sha256(stableStringify({
        shop,
        operationId: set.operationId,
        mirrorBatchId,
        targetKey,
        targetResourceType,
        beforeValues,
        plannedMutation,
      })),
    };
  });
  const result = await db.targetSnapshotItem.createMany({ data, skipDuplicates });
  return result;
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
  const keys = await db.targetSnapshotItem.findMany({
    where: { shop, snapshotSetId: set.id },
    select: { targetKey: true },
    orderBy: [{ targetKey: "asc" }],
  });
  await db.targetSnapshotSet.updateMany({
    where: { id: set.id, shop, status: { in: ["FREEZING", "FROZEN"] } },
    data: {
      status: "FROZEN",
      targetSetHash: sha256(keys.map((row) => row.targetKey).join("\n")),
      frozenAt: new Date(),
      freezeErrorCode: null,
      freezeErrorMessage: null,
    },
  });
  return db.targetSnapshotSet.findFirst({ where: { id: set.id, shop } });
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

function buildTargetKey(row) {
  const targetResourceType = String(row?.targetResourceType || "").toUpperCase();
  if (targetResourceType === "PRODUCT") return `PRODUCT:${String(row?.productId || "").trim()}`;
  if (targetResourceType === "VARIANT") return `VARIANT:${String(row?.variantId || "").trim()}`;
  return `${targetResourceType}:${String(row?.targetIdentity || "").trim()}`;
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
      productId: row?.productId || null,
      variantId: row?.variantId || null,
      beforeValues: row?.beforeValues || null,
      plannedMutation: row?.plannedMutation || {},
      targetRowHash: sha256(targetKey),
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
      where: { id: existing.id },
      data: {
        previewContractId: resolvedPreviewContractId,
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
        previewContractId: resolvedPreviewContractId,
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
    let itemOrdinal = 0;

    for (const frozenRow of frozenRows) {
      const targetResourceType = String(frozenRow?.targetResourceType || "").toUpperCase();
      const targetKey = buildTargetKey(frozenRow);
      if (!targetKey || targetKey.endsWith(":")) {
        continue;
      }
      const plannedMutation =
        frozenRow.beforeValues &&
        typeof frozenRow.beforeValues === "object" &&
        !Array.isArray(frozenRow.beforeValues) &&
        frozenRow.beforeValues.plannedMutation &&
        typeof frozenRow.beforeValues.plannedMutation === "object"
          ? frozenRow.beforeValues.plannedMutation
          : {};
      const rowChecksum = buildRowChecksum({
        snapshotSetId: set.id,
        shop,
        operationId: resolvedOperationId,
        mirrorBatchId: resolvedMirrorBatchId,
        row: { ...frozenRow, plannedMutation },
        targetKey,
        compilerVersion,
        projectionVersion,
      });
      rowChecksums.push(rowChecksum);
      if (targetResourceType === "PRODUCT") productCount += 1;
      if (targetResourceType === "VARIANT") variantCount += 1;
      if (targetResourceType === "INVENTORY_ITEM") inventoryItemCount += 1;
      if (targetResourceType === "METAFIELD") metafieldCount += 1;
      rows.push({
        snapshotSetId: set.id,
        shop,
        operationId: resolvedOperationId,
        mirrorBatchId: resolvedMirrorBatchId,
        productId: frozenRow.productId ? String(frozenRow.productId).trim() : null,
        variantId: frozenRow.variantId ? String(frozenRow.variantId).trim() : null,
        targetKey,
        targetResourceType,
        targetGranularity: frozenRow.targetGranularity || null,
        ordinal: Number.isInteger(frozenRow.ordinal) ? frozenRow.ordinal : itemOrdinal,
        mutationGroupKey: source,
        beforeValues: frozenRow.beforeValues || {},
        plannedMutation,
        targetRowHash: sha256(targetKey),
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
      where: { id: set.id },
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
        COUNT(*) FILTER (WHERE item."executionStatus" = 'PENDING')::integer AS "mutationPendingCount",
        COUNT(*) FILTER (WHERE item."executionStatus" = 'SUBMITTED')::integer AS "mutationSubmittedCount",
        COUNT(*) FILTER (WHERE item."executionStatus" = 'SUCCEEDED')::integer AS "mutationSucceededCount",
        COUNT(*) FILTER (WHERE item."executionStatus" = 'FAILED')::integer AS "mutationFailedCount",
        COUNT(*) FILTER (WHERE item."executionStatus" = 'SKIPPED')::integer AS "mutationSkippedCount",
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

export async function listFrozenSnapshotItemsPage({
  shop,
  snapshotSetId,
  cursorTargetKey = null,
  lastTargetKey = null,
  limit = 1000,
  targetResourceType = null,
  targetKeys = null,
  executionStatus = null,
  undoStatus = null,
  db = prisma,
}) {
  const resolvedLastTargetKey = String(lastTargetKey || cursorTargetKey || "").trim() || null;
  const where = {
    shop,
    snapshotSetId,
    ...(targetResourceType ? { targetResourceType } : {}),
    ...(Array.isArray(targetKeys) && targetKeys.length > 0 ? { targetKey: { in: targetKeys } } : {}),
    ...(executionStatus ? { executionStatus } : {}),
    ...(undoStatus ? { undoStatus } : {}),
    ...(resolvedLastTargetKey ? { targetKey: { gt: resolvedLastTargetKey } } : {}),
  };

  const rows = await db.targetSnapshotItem.findMany({
    where,
    orderBy: [{ targetKey: "asc" }],
    take: limit + 1,
    select: {
      id: true,
      productId: true,
      variantId: true,
      targetResourceType: true,
      targetKey: true,
      beforeValues: true,
      plannedMutation: true,
      rowChecksum: true,
      executionStatus: true,
      undoStatus: true,
    },
  });

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  return {
    rows: pageRows,
    hasMore,
    cursorTargetKey: pageRows.length ? pageRows[pageRows.length - 1].targetKey : null,
  };
}

export function isTerminalSnapshotSetStatus(status) {
  return TERMINAL_SET_STATUSES.has(String(status || "").toUpperCase());
}
