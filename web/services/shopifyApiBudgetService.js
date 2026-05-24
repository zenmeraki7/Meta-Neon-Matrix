import { prisma } from "../config/database.js";
import {
  acquireOperationLease,
  releaseOperationLease,
} from "./operationLeaseService.js";

const BULK_NS = "shopify_bulk_operation";
const DESTRUCTIVE_NS = "shop_destructive_catalog_operation";

export async function acquireShopifyExecutionBudget({
  shop,
  ownerId,
  queueName,
  destructive = true,
  ttlMs = 5 * 60 * 1000,
}) {
  const globalLimit = Number.parseInt(process.env.GLOBAL_SHOPIFY_BULK_CONCURRENCY || "8", 10);
  const activeGlobal = await prisma.operationLease.count({
    where: {
      namespace: BULK_NS,
      releasedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
  if (Number.isFinite(globalLimit) && activeGlobal >= globalLimit) {
    return { acquired: false, reason: "global_api_budget_exhausted" };
  }

  const bulkLease = await acquireOperationLease({
    shop,
    namespace: BULK_NS,
    resourceId: shop,
    ownerId: `${queueName || "worker"}:${ownerId}:bulk`,
    ttlMs,
  });
  if (!bulkLease.acquired) {
    return { acquired: false, reason: "shopify_bulk_overlap" };
  }

  let destructiveLease = null;
  if (destructive) {
    destructiveLease = await acquireOperationLease({
      shop,
      namespace: DESTRUCTIVE_NS,
      resourceId: shop,
      ownerId: `${queueName || "worker"}:${ownerId}:destructive`,
      ttlMs,
    });
    if (!destructiveLease.acquired) {
      await releaseOperationLease({
        shop,
        namespace: BULK_NS,
        resourceId: shop,
        ownerId: `${queueName || "worker"}:${ownerId}:bulk`,
      });
      return { acquired: false, reason: "destructive_overlap" };
    }
  }

  return {
    acquired: true,
    leases: {
      bulk: {
        namespace: BULK_NS,
        resourceId: shop,
        ownerId: `${queueName || "worker"}:${ownerId}:bulk`,
      },
      destructive: destructiveLease
        ? {
          namespace: DESTRUCTIVE_NS,
          resourceId: shop,
          ownerId: `${queueName || "worker"}:${ownerId}:destructive`,
        }
        : null,
    },
  };
}

export async function releaseShopifyExecutionBudget({ shop, leases }) {
  if (!leases) return;
  if (leases.bulk) {
    await releaseOperationLease({
      shop,
      namespace: leases.bulk.namespace,
      resourceId: leases.bulk.resourceId,
      ownerId: leases.bulk.ownerId,
    }).catch(() => {});
  }
  if (leases.destructive) {
    await releaseOperationLease({
      shop,
      namespace: leases.destructive.namespace,
      resourceId: leases.destructive.resourceId,
      ownerId: leases.destructive.ownerId,
    }).catch(() => {});
  }
}

