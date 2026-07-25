import { prisma } from "../config/database.js";
import { requireShopScope } from "../utils/shopScope.js";
import { normalizeEditHistoryExecutionState } from "../utils/normalizedStateUtils.js";

const ACTIVE_EXECUTION_STATES = [
  "QUEUED",
  "SCHEDULED_QUEUED",
  "TARGET_FREEZING",
  "TARGET_FROZEN",
  "PLANNED",
  "EXECUTING",
  "WAITING_FOR_SHOPIFY_SLOT",
  "VERIFYING",
  "UNDO_QUEUED",
  "UNDO_EXECUTING",
];
const ACTIVE_EXECUTION_STATES_NORMALIZED = [
  ...new Set(ACTIVE_EXECUTION_STATES.map(normalizeEditHistoryExecutionState)),
];

export async function getOperationSummaryByShop(shop) {
  const resolvedShop = requireShopScope(shop);

  const [activeCount, latestActive] = await Promise.all([
    prisma.editHistory.count({
      where: {
        shop: resolvedShop,
        executionStateNormalized: { in: ACTIVE_EXECUTION_STATES_NORMALIZED },
      },
    }),
    prisma.editHistory.findFirst({
      where: {
        shop: resolvedShop,
        executionStateNormalized: { in: ACTIVE_EXECUTION_STATES_NORMALIZED },
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        executionStateNormalized: true,
        statusNormalized: true,
        createdAt: true,
        updatedAt: true,
        processedCount: true,
        totalItems: true,
      },
    }),
  ]);

  return {
    activeCount: Number(activeCount || 0),
    latestActiveOperation: latestActive
      ? {
        id: latestActive.id,
        executionState: latestActive.executionStateNormalized || null,
        status: latestActive.statusNormalized || null,
        createdAt: latestActive.createdAt || null,
        updatedAt: latestActive.updatedAt || null,
        processedCount: Number(latestActive.processedCount || 0),
        totalItems: Number(latestActive.totalItems || 0),
      }
      : null,
  };
}

export async function getSubscriptionPlanSnapshotByShop(shop) {
  const resolvedShop = requireShopScope(shop);

  return prisma.subscription.findFirst({
    where: { shop: resolvedShop },
    select: { planKey: true, status: true },
  });
}
