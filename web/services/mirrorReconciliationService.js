import { db } from "../repositories/repositoryDb.js";
import crypto from "crypto";
import {
  markRepairRequired,
  markTargetedReconciliationPending,
  MIRROR_STALE_REASONS,
} from "./mirrorHealthService.js";
import { addShopSyncJob } from "../Jobs/Queues/shopSyncJob.js";

const TARGETED_RECONCILIATION_LIMIT = Number.parseInt(
  process.env.TARGETED_RECONCILIATION_LIMIT || "500",
  10,
);

export async function schedulePostMutationMirrorReconciliation({
  shop,
  ownerType,
  ownerId,
  mirrorBatchId = null,
  source = "BULK_EDIT",
  verificationStatus = "UNKNOWN",
}) {
  const snapshots = await db.targetSnapshot.findMany({
    where: {
      shop,
      ownerType,
      ownerId,
      ...(mirrorBatchId ? { mirrorBatchId } : {}),
      productId: { not: null },
    },
    select: { productId: true },
    distinct: ["productId"],
    take: TARGETED_RECONCILIATION_LIMIT + 1,
  });

  const productIds = snapshots.map((row) => row.productId).filter(Boolean);
  if (!productIds.length) {
    return { mode: "none", productCount: 0 };
  }

  if (productIds.length > TARGETED_RECONCILIATION_LIMIT) {
    await markRepairRequired({
      shop,
      reason: MIRROR_STALE_REASONS.PARTIAL_MIRROR_DETECTED,
      summary: "Bulk mutation exceeded targeted mirror reconciliation threshold; full sync required.",
      details: {
        ownerType,
        ownerId,
        mirrorBatchId,
        verificationStatus,
        productCount: productIds.length,
        threshold: TARGETED_RECONCILIATION_LIMIT,
      },
    });
    await addShopSyncJob({
      shop,
      syncType: "product",
      reason: "post_mutation_full_resync_required",
    });
    return { mode: "full_sync", productCount: productIds.length };
  }

  await db.$transaction(async (tx) => {
    for (const productId of productIds) {
      await tx.mirrorReconcileSignal.upsert({
        where: {
          shop_entityType_entityId: {
            shop,
            entityType: "PRODUCT",
            entityId: productId,
          },
        },
        create: {
          id: `mrs_${crypto.createHash("sha1").update(`${shop}:${productId}`).digest("hex")}`,
          shop,
          entityType: "PRODUCT",
          entityId: productId,
          topic: source,
          status: "pending",
          signalCount: 1,
          latestEventAt: new Date(),
        },
        update: {
          topic: source,
          status: "pending",
          signalCount: { increment: 1 },
          latestEventAt: new Date(),
          updatedAt: new Date(),
        },
      });
    }
  });

  await markTargetedReconciliationPending({
    shop,
    reason: MIRROR_STALE_REASONS.PARTIAL_MIRROR_DETECTED,
    summary: "Bulk mutation completed; mirror marked stale until targeted reconciliation runs.",
    details: {
      ownerType,
      ownerId,
      mirrorBatchId,
      verificationStatus,
      productCount: productIds.length,
      targeted: true,
    },
  });

  await addShopSyncJob({
    shop,
    syncType: "product",
    reason: "post_mutation_targeted_reconciliation_pending",
  });

  return { mode: "targeted_signals", productCount: productIds.length };
}

