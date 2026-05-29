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
  const targetType = String(row?.targetType || "").toUpperCase();
  if (targetType === "PRODUCT") return `PRODUCT:${String(row?.productId || "").trim()}`;
  if (targetType === "VARIANT") return `VARIANT:${String(row?.variantId || "").trim()}`;
  return `${targetType}:${String(row?.targetIdentity || "").trim()}`;
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
      targetType: String(row?.targetType || "").toUpperCase(),
      targetKey,
      productId: row?.productId || null,
      variantId: row?.variantId || null,
      beforeValues: row?.beforeValues || null,
      plannedMutation: row?.plannedMutation || {},
      targetFingerprint: sha256(targetKey),
      compilerVersion,
      projectionVersion,
    }),
  );
}

function buildSetChecksum({
  shop,
  operationId,
  previewContractId,
  mirrorBatchId,
  targetingFingerprint,
  compilerVersion,
  projectionVersion,
  targetCount,
  productCount,
  variantCount,
  sortedRowChecksums,
}) {
  return sha256(
    stableStringify({
      shop,
      operationId,
      previewContractId,
      mirrorBatchId,
      targetingFingerprint,
      compilerVersion,
      projectionVersion,
      targetCount,
      productCount,
      variantCount,
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
  targetingFingerprint,
  compilerVersion = "legacy-v1",
  projectionVersion = "legacy-v1",
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
        targetingFingerprint: String(targetingFingerprint || "").trim() || sha256(`${shop}:${historyId}:${resolvedMirrorBatchId}`),
        compilerVersion,
        projectionVersion,
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
        targetType: true,
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

    for (const legacyRow of legacyRows) {
      const targetType = String(legacyRow?.targetType || "").toUpperCase();
      const targetKey = buildTargetKey(legacyRow);
      if (!targetKey || targetKey.endsWith(":")) {
        continue;
      }
      const rowChecksum = buildRowChecksum({
        snapshotSetId: set.id,
        shop,
        operationId: resolvedOperationId,
        mirrorBatchId: resolvedMirrorBatchId,
        row: legacyRow,
        targetKey,
        compilerVersion,
        projectionVersion,
      });
      rowChecksums.push(rowChecksum);
      if (targetType === "PRODUCT") productCount += 1;
      if (targetType === "VARIANT") variantCount += 1;
      rows.push({
        snapshotSetId: set.id,
        shop,
        operationId: resolvedOperationId,
        mirrorBatchId: resolvedMirrorBatchId,
        productId: String(legacyRow.productId || "").trim(),
        variantId: legacyRow.variantId ? String(legacyRow.variantId).trim() : null,
        targetKey,
        targetType,
        mutationGroupKey: source,
        beforeValues: legacyRow.beforeValues || {},
        plannedMutation: {},
        targetFingerprint: sha256(targetKey),
        rowChecksum,
      });
    }

    const CHUNK = 1000;
    for (let i = 0; i < rows.length; i += CHUNK) {
      // eslint-disable-next-line no-await-in-loop
      await db.targetSnapshotItem.createMany({
        data: rows.slice(i, i + CHUNK),
        skipDuplicates: true,
      });
    }

    const targetCount = rows.length;
    const sortedRowChecksums = [...rowChecksums].sort();
    const setChecksum = buildSetChecksum({
      shop,
      operationId: resolvedOperationId,
      previewContractId: resolvedPreviewContractId,
      mirrorBatchId: resolvedMirrorBatchId,
      targetingFingerprint: set.targetingFingerprint,
      compilerVersion,
      projectionVersion,
      targetCount,
      productCount,
      variantCount,
      sortedRowChecksums,
    });

    const frozenSet = await db.targetSnapshotSet.update({
      where: { id: set.id },
      data: {
        status: "FROZEN",
        checksum: setChecksum,
        targetCount,
        productCount,
        variantCount,
        pendingCount: targetCount,
        submittedCount: 0,
        succeededCount: 0,
        failedCount: 0,
        skippedCount: 0,
        verifiedCount: 0,
        undoPendingCount: 0,
        undoSucceededCount: 0,
        undoFailedCount: 0,
        frozenAt: new Date(),
        failedAt: null,
      },
    });

    return frozenSet;
  } catch (error) {
    await db.targetSnapshotSet.update({
      where: { id: set.id },
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
  if (!set.checksum) {
    await db.targetSnapshotSet.updateMany({
      where: { id: set.id, shop, status: "FROZEN" },
      data: {
        status: "CORRUPTED",
        freezeErrorCode: "SNAPSHOT_CHECKSUM_MISSING",
        freezeErrorMessage: "Frozen snapshot set checksum missing",
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

export async function listFrozenSnapshotItemsPage({
  shop,
  snapshotSetId,
  cursorTargetKey = null,
  limit = 250,
  targetType = null,
  targetKeys = null,
  executionStatus = null,
  undoStatus = null,
  db = prisma,
}) {
  const where = {
    shop,
    snapshotSetId,
    ...(targetType ? { targetType } : {}),
    ...(Array.isArray(targetKeys) && targetKeys.length > 0 ? { targetKey: { in: targetKeys } } : {}),
    ...(executionStatus ? { executionStatus } : {}),
    ...(undoStatus ? { undoStatus } : {}),
    ...(cursorTargetKey ? { targetKey: { gt: cursorTargetKey } } : {}),
  };

  const rows = await db.targetSnapshotItem.findMany({
    where,
    orderBy: [{ targetKey: "asc" }],
    take: limit + 1,
    select: {
      id: true,
      productId: true,
      variantId: true,
      targetType: true,
      targetKey: true,
      beforeValues: true,
      plannedMutation: true,
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
