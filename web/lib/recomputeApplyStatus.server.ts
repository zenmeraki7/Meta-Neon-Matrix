import type { Prisma } from "@prisma/client";
import { prisma } from "../config/database.js";

type DatabaseClient = Prisma.TransactionClient | typeof prisma;
type BulkApplyItemStatus =
  | "PENDING"
  | "APPLYING"
  | "APPLIED"
  | "FAILED"
  | "FAILED_PERMANENT"
  | "CANCELLED"
  | "SKIPPED";
type BulkApplyRequestStatus =
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "PARTIAL_FAILED"
  | "FAILED"
  | "CANCELLED";

const TERMINAL_REQUEST_STATUSES = new Set([
  "COMPLETED",
  "PARTIAL_FAILED",
  "FAILED",
  "CANCELLED",
]);

export async function recomputeApplyRequestStatus({
  shop,
  applyRequestId,
  db = prisma,
}: {
  shop: string;
  bulkApplyJobId?: string;
  applyRequestId: string;
  db?: DatabaseClient;
}) {
  const items = (await db.bulkApplyItem.groupBy({
    by: ["status"],
    where: { shop, requestId: applyRequestId },
    _count: { status: true },
  })) as Array<{ status: string; _count: { status: number } }>;

  const count = (status: string) =>
    items.find((item) => item.status === status)?._count.status ?? 0;

  const pendingItemCount = count("PENDING");
  const applyingItemCount = count("APPLYING");
  const appliedItemCount = count("APPLIED");
  const failedItemCount = count("FAILED") + count("FAILED_PERMANENT");
  const cancelledItemCount = count("CANCELLED");
  const skippedItemCount = count("SKIPPED");
  const eligibleItemCount =
    pendingItemCount +
    applyingItemCount +
    appliedItemCount +
    failedItemCount +
    cancelledItemCount +
    skippedItemCount;

  let status: BulkApplyRequestStatus = "RUNNING";
  if (cancelledItemCount > 0 && pendingItemCount + applyingItemCount === 0) {
    status = "CANCELLED";
  } else if (eligibleItemCount > 0 && appliedItemCount === eligibleItemCount) {
    status = "COMPLETED";
  } else if (
    pendingItemCount + applyingItemCount === 0 &&
    failedItemCount > 0 &&
    appliedItemCount > 0
  ) {
    status = "PARTIAL_FAILED";
  } else if (
    pendingItemCount + applyingItemCount === 0 &&
    failedItemCount > 0 &&
    appliedItemCount === 0
  ) {
    status = "FAILED";
  }

  return db.bulkApplyRequest.updateMany({
    where: { id: applyRequestId, shop },
    data: {
      status,
      eligibleItemCount,
      pendingItemCount,
      applyingItemCount,
      appliedItemCount,
      failedItemCount,
      cancelledItemCount,
      skippedItemCount,
      finishedAt: TERMINAL_REQUEST_STATUSES.has(status) ? new Date() : null,
    },
  });
}

export async function transitionBulkApplyItemStatus({
  shop,
  applyRequestId,
  itemId,
  allowedFrom,
  to,
  data = {},
}: {
  shop: string;
  applyRequestId: string;
  itemId: string;
  allowedFrom: BulkApplyItemStatus[];
  to: BulkApplyItemStatus;
  data?: Prisma.BulkApplyItemUpdateManyMutationInput;
}) {
  return prisma.$transaction(async (tx) => {
    const changed = await tx.bulkApplyItem.updateMany({
      where: {
        id: itemId,
        shop,
        requestId: applyRequestId,
        status: { in: allowedFrom },
      },
      data: { ...data, status: to },
    });

    if (changed.count === 1) {
      await recomputeApplyRequestStatus({ shop, applyRequestId, db: tx });
    }

    return changed;
  });
}

export async function transitionBulkApplyItemsStatus({
  shop,
  applyRequestId,
  allowedFrom,
  to,
  data = {},
}: {
  shop: string;
  applyRequestId: string;
  allowedFrom: BulkApplyItemStatus[];
  to: BulkApplyItemStatus;
  data?: Prisma.BulkApplyItemUpdateManyMutationInput;
}) {
  return prisma.$transaction(async (tx) => {
    const changed = await tx.bulkApplyItem.updateMany({
      where: {
        shop,
        requestId: applyRequestId,
        status: { in: allowedFrom },
      },
      data: { ...data, status: to },
    });

    if (changed.count > 0) {
      await recomputeApplyRequestStatus({ shop, applyRequestId, db: tx });
    }

    return changed;
  });
}
