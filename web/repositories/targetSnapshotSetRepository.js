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

export async function upsertFrozenSnapshotSetFromLegacy({
  shop,
  historyId,
  operationId,
  previewContractId,
  mirrorBatchId,
  targetDefinitionHash,
  compilerVersion = "legacy-v1",
  projectionVersion = "legacy-v1",
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
    const legacyRows = await db.targetSnapshot.findMany({
      where: {
        shop,
        ownerType: "EDIT_HISTORY",
        ownerId: historyId,
        mirrorBatchId: resolvedMirrorBatchId,
      },
      orderBy: [{ ordinal: "asc" }, { id: "asc" }],
      select: {
        productId: true,
        variantId: true,
        targetResourceType: true,
        targetIdentity: true,
        beforeValues: true,
      },
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

    for (const legacyRow of legacyRows) {
      const targetResourceType = String(legacyRow?.targetResourceType || "").toUpperCase();
      const targetKey = buildTargetKey(legacyRow);
      if (!targetKey || targetKey.endsWith(":")) {
        continue;
      }
      const plannedMutation =
        legacyRow.beforeValues &&
        typeof legacyRow.beforeValues === "object" &&
        !Array.isArray(legacyRow.beforeValues) &&
        legacyRow.beforeValues.plannedMutation &&
        typeof legacyRow.beforeValues.plannedMutation === "object"
          ? legacyRow.beforeValues.plannedMutation
          : {};
      const rowChecksum = buildRowChecksum({
        snapshotSetId: set.id,
        shop,
        operationId: resolvedOperationId,
        mirrorBatchId: resolvedMirrorBatchId,
        row: { ...legacyRow, plannedMutation },
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
        productId: String(legacyRow.productId || "").trim(),
        variantId: legacyRow.variantId ? String(legacyRow.variantId).trim() : null,
        targetKey,
        targetResourceType,
        mutationGroupKey: source,
        beforeValues: legacyRow.beforeValues || {},
        plannedMutation,
        targetRowHash: sha256(targetKey),
        rowChecksum,
      });
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
