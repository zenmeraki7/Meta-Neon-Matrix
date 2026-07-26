import { db } from "../repositories/repositoryDb.js";
import {
  markRepairRequired,
  markTargetedReconciliationPending,
  MIRROR_STALE_REASONS,
} from "./mirrorHealthService.js";
import { addShopSyncJob } from "../Jobs/Queues/shopSyncJob.js";
import { findSnapshotItems } from "../repositories/targetSnapshotSetRepository.js";

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
  const snapshots = await findSnapshotItems({
    shop,
    operationType: ownerType,
    operationRecordId: ownerId,
    mirrorBatchId,
    productIdNotNull: true,
    distinctProductIds: true,
    take: TARGETED_RECONCILIATION_LIMIT + 1,
    db,
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
      shopDomain: shop,
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
          shop,
          entityType: "PRODUCT",
          entityId: productId,
          topic: source,
          status: "PENDING",
          signalCount: 1,
          latestSourceEventOccurredAt: new Date(),
        },
        update: {
          topic: source,
          status: "PENDING",
          signalCount: { increment: 1 },
          latestSourceEventOccurredAt: new Date(),
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
    shopDomain: shop,
    syncType: "product",
    reason: "post_mutation_targeted_reconciliation_pending",
  });

  return { mode: "targeted_signals", productCount: productIds.length };
}
