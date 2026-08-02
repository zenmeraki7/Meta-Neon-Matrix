import crypto from "crypto";
import { db } from "../repositories/repositoryDb.js";

function sha256(input) {
  return crypto.createHash("sha256").update(String(input || "")).digest("hex");
}

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

function toObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function toNonEmptyString(value) {
  const text = String(value || "").trim();
  return text || null;
}

function buildTargetKey(item) {
  const targetResourceType = String(item?.targetResourceType || "").toUpperCase();
  const productId = toNonEmptyString(item?.productId);
  const variantId = toNonEmptyString(item?.variantId);
  const beforeValues = toObject(item?.beforeValues);

  if (targetResourceType === "PRODUCT") {
    if (!productId) throw new Error(`TARGET_KEY_UNRESOLVABLE:PRODUCT:${item.id}`);
    return `PRODUCT:${productId}`;
  }

  if (targetResourceType === "VARIANT") {
    if (!variantId) throw new Error(`TARGET_KEY_UNRESOLVABLE:VARIANT:${item.id}`);
    return `VARIANT:${variantId}`;
  }

  if (targetResourceType === "INVENTORY_ITEM") {
    const inventoryItemId =
      toNonEmptyString(beforeValues?.inventoryItemId)
      || toNonEmptyString(beforeValues?.beforeValues?.inventoryItemId);
    if (!inventoryItemId) {
      throw new Error(`TARGET_KEY_UNRESOLVABLE:INVENTORY_ITEM:${item.id}`);
    }
    return `INVENTORY_ITEM:${inventoryItemId}`;
  }

  if (targetResourceType === "METAFIELD") {
    const ownerId =
      toNonEmptyString(beforeValues?.ownerId)
      || toNonEmptyString(beforeValues?.beforeValues?.ownerId)
      || variantId
      || productId;
    const namespace =
      toNonEmptyString(beforeValues?.namespace)
      || toNonEmptyString(beforeValues?.beforeValues?.namespace);
    const key =
      toNonEmptyString(beforeValues?.key)
      || toNonEmptyString(beforeValues?.beforeValues?.key);
    if (!ownerId || !namespace || !key) {
      throw new Error(`TARGET_KEY_UNRESOLVABLE:METAFIELD:${item.id}`);
    }
    return `METAFIELD:${ownerId}:${namespace}:${key}`;
  }

  throw new Error(`Unsupported targetResourceType: ${targetResourceType || "UNKNOWN"}`);
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
      plannerVersion,
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

async function resolveEditHistory(tx, { shop, operationId }) {
  const direct = await tx.editHistory.findFirst({
    where: { shop, OR: [{ executionIdentity: operationId }, { id: operationId }] },
    select: {
      id: true,
      batch: true,
      normalizedFilterHash: true,
      targetProductMirrorBatchId: true,
    },
  });
  if (direct) return direct;

  const legacyPrefix = "EDIT_HISTORY:";
  if (!String(operationId).startsWith(legacyPrefix)) return null;
  const historyId = String(operationId).slice(legacyPrefix.length).trim();
  if (!historyId) return null;
  return tx.editHistory.findFirst({
    where: { id: historyId, shop },
    select: {
      id: true,
      batch: true,
      normalizedFilterHash: true,
      targetProductMirrorBatchId: true,
    },
  });
}

async function backfillOperation({ shop, operationId, dryRun = false }) {
  return db.$transaction(async (tx) => {
    const rowsNeedingBackfill = await tx.targetSnapshotItem.findMany({
      where: {
        shop,
        operationId,
        OR: [{ snapshotSetId: null }, { targetKey: null }],
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        snapshotSetId: true,
        targetKey: true,
        targetResourceType: true,
        productId: true,
        variantId: true,
        mirrorBatchId: true,
        beforeValues: true,
        rowChecksum: true,
      },
    });
    if (!rowsNeedingBackfill.length) {
      return { shop, operationId, touched: 0, insertedSet: false };
    }

    const mirrorBatchIds = [...new Set(rowsNeedingBackfill.map((r) => String(r.mirrorBatchId || "").trim()).filter(Boolean))];
    if (mirrorBatchIds.length !== 1) {
      throw new Error(`BACKFILL_CORRUPTED_MIRROR_BATCH_SET:${shop}:${operationId}`);
    }
    const mirrorBatchId = mirrorBatchIds[0];

    const history = await resolveEditHistory(tx, { shop, operationId });
    const targetDefinitionHash =
      toNonEmptyString(history?.normalizedFilterHash) || sha256(`${shop}:${operationId}:${mirrorBatchId}`);
    const compilerVersion =
      toNonEmptyString(history?.batch?.targetingCompilerVersion) || "legacy-v1";
    const projectionVersion =
      toNonEmptyString(history?.batch?.projectionVersion) || "legacy-v1";
    const plannerVersion =
      toNonEmptyString(history?.batch?.plannerVersion) || null;
    const previewContractId =
      toNonEmptyString(history?.batch?.previewContractId)
      || toNonEmptyString(history?.batch?.previewId)
      || operationId;

    let snapshotSet = await tx.targetSnapshotSet.findFirst({
      where: { shop, operationId },
      select: { id: true, status: true },
    });
    let insertedSet = false;
    if (!snapshotSet) {
      if (dryRun) {
        snapshotSet = { id: "DRY_RUN_SET_ID", status: "FROZEN" };
      } else {
        snapshotSet = await tx.targetSnapshotSet.create({
          data: {
            shop,
            operationId,
            mirrorBatchId,
            targetDefinitionHash,
            compilerVersion,
            projectionVersion,
            plannerVersion,
            status: "FREEZING",
          },
          select: { id: true, status: true },
        });
      }
      insertedSet = true;
    }

    const resolvedSetId = snapshotSet.id;
    const existingRowsInSet = dryRun
      ? []
      : await tx.targetSnapshotItem.findMany({
        where: { shop, snapshotSetId: resolvedSetId },
        select: { id: true, targetKey: true },
      });
    const existingTargetKeys = new Set(
      existingRowsInSet
        .map((row) => toNonEmptyString(row.targetKey))
        .filter(Boolean),
    );

    const seen = new Set(existingTargetKeys);
    const updates = [];
    const rowChecksums = [];
    let productCount = 0;
    let variantCount = 0;
    let inventoryItemCount = 0;
    let metafieldCount = 0;

    for (const row of rowsNeedingBackfill) {
      const derivedTargetKey = toNonEmptyString(row.targetKey) || buildTargetKey(row);
      const duplicateKey = `${resolvedSetId}::${derivedTargetKey}`;
      if (seen.has(derivedTargetKey)) {
        throw new Error(`BACKFILL_DUPLICATE_TARGET_KEY:${duplicateKey}`);
      }
      seen.add(derivedTargetKey);

      const targetResourceType = String(row.targetResourceType || "").toUpperCase();
      if (targetResourceType === "PRODUCT") productCount += 1;
      if (targetResourceType === "VARIANT") variantCount += 1;
      if (targetResourceType === "INVENTORY_ITEM") inventoryItemCount += 1;
      if (targetResourceType === "METAFIELD") metafieldCount += 1;
      rowChecksums.push(String(row.rowChecksum || "").trim());

      updates.push({
        id: row.id,
        snapshotSetId: resolvedSetId,
        targetKey: derivedTargetKey,
      });
    }

    const targetCount = seen.size;
    const allChecksumsPresent = rowChecksums.every((checksum) => checksum.length > 0);
    const sortedRowChecksums = allChecksumsPresent ? [...rowChecksums].sort() : [];
    const targetSetHash = allChecksumsPresent
      ? buildTargetSetHash({
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
      })
      : null;

    if (!dryRun) {
      for (const update of updates) {
        // eslint-disable-next-line no-await-in-loop
        await tx.targetSnapshotItem.update({
          where: { shop_id: { shop, id: update.id } },
          data: {
            snapshotSetId: update.snapshotSetId,
            targetKey: update.targetKey,
          },
        });
      }

      const frozenAt = new Date();
      const finalized = await tx.targetSnapshotSet.updateMany({
        where: { id: resolvedSetId, shop, status: "FREEZING" },
        data: {
          status: "FROZEN",
          targetCount,
          productCount,
          variantCount,
          inventoryItemCount,
          metafieldCount,
          targetSetHash,
          mutationPendingCount: targetCount,
          mutationSubmittedCount: 0,
          mutationSucceededCount: 0,
          mutationFailedCount: 0,
          mutationSkippedCount: 0,
          verificationPendingCount: 0,
          verificationSucceededCount: 0,
          verificationFailedCount: 0,
          frozenAt,
          failedAt: null,
          freezeErrorCode: null,
          freezeErrorMessage: null,
        },
      });
      if (Number(finalized.count || 0) !== 1) {
        const setCurrent = await tx.targetSnapshotSet.findUnique({
          where: { id: resolvedSetId },
          select: { status: true },
        });
        if (String(setCurrent?.status || "").toUpperCase() !== "FROZEN") {
          throw new Error(`BACKFILL_SET_FINALIZE_REJECTED:${shop}:${operationId}`);
        }
      }
    }

    return {
      shop,
      operationId,
      touched: updates.length,
      insertedSet,
      snapshotSetId: resolvedSetId,
      targetCount,
      targetSetHashComputed: Boolean(targetSetHash),
      dryRun,
    };
  });
}

async function run() {
  const dryRun = process.argv.includes("--dry-run");

  const operations = await db.targetSnapshotItem.findMany({
    where: {
      OR: [{ snapshotSetId: null }, { targetKey: null }],
    },
    select: {
      shop: true,
      operationId: true,
    },
    distinct: ["shop", "operationId"],
    orderBy: [{ shop: "asc" }, { operationId: "asc" }],
  });

  if (!operations.length) {
    console.log("No TargetSnapshotItem rows require backfill.");
    return;
  }

  let totalTouched = 0;
  for (const op of operations) {
    // eslint-disable-next-line no-await-in-loop
    const result = await backfillOperation({
      shop: op.shop,
      operationId: op.operationId,
      dryRun,
    });
    totalTouched += Number(result.touched || 0);
    console.log(
      `[backfill] shop=${result.shop} operationId=${result.operationId} touched=${result.touched} set=${result.snapshotSetId} insertedSet=${result.insertedSet} dryRun=${dryRun}`,
    );
  }

  console.log(
    `[backfill] complete operations=${operations.length} touchedRows=${totalTouched} dryRun=${dryRun}`,
  );
}

run()
  .catch((error) => {
    console.error("Target snapshot backfill failed:", error?.message || error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
