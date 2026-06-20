// app/lib/recomputeApplyStatus.server.ts
import { prisma } from "../config/database.js";

export async function recomputeApplyRequestStatus({
  shop,
  bulkJobId,
  applyRequestId,
}: {
  shop: string;
  bulkJobId: string;
  applyRequestId: string;
}) {
  const items = (await prisma.bulkApplyItem.groupBy({
    by: ["status"],
    where: { shop, bulkJobId },
    _count: { status: true },
  })) as Array<{ status: string; _count: { status: number } }>;

  const count = (status: string) =>
    items.find((x) => x.status === status)?._count.status ?? 0;

  const pending = count("PENDING");
  const applying = count("APPLYING");
  const applied = count("APPLIED");
  const failed = count("FAILED");
  const cancelled = count("CANCELLED");
  const skipped = count("SKIPPED");
  const total = pending + applying + applied + failed + cancelled + skipped;

  let status = "RUNNING";

  if (cancelled > 0 && pending + applying === 0) status = "CANCELLED";
  else if (total > 0 && applied === total) status = "COMPLETED";
  else if (failed > 0 && applied > 0) status = "PARTIAL_FAILED";
  else if (failed > 0 && applied === 0 && pending + applying === 0)
    status = "FAILED";

  await prisma.bulkApplyRequest.update({
    where: { id: applyRequestId },
    data: {
      status,
      totalCount: total,
      appliedCount: applied,
      failedCount: failed,
      cancelledCount: cancelled,
      skippedCount: skipped,
      finishedAt: [
        "COMPLETED",
        "PARTIAL_FAILED",
        "FAILED",
        "CANCELLED",
      ].includes(status)
        ? new Date()
        : null,
    },
  });
}
