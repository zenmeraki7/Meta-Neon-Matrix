// web/Jobs/Queues/productSyncQueue.js

import crypto from "node:crypto";
import {
  productSyncExecuteQueue,
  productSyncSchedulerQueue,
} from "../../queues/adapters/jobsQueueInstancesAdapter.js";
import { db } from "../../repositories/repositoryDb.js";
import {
  PRODUCT_SYNC_JOB_OPTIONS,
} from "../../queues/productSyncQueue.constants.js";
import { joinSafeJobId } from "../../utils/jobQueueUtils.js";
import { SYNC_OPERATION_TYPE, SYNC_STATUS_NORMALIZED } from "../../constants/syncConstants.js";
import { buildImmutablePayloadMetadata } from "../../utils/immutablePayloadUtils.js";
import { normalizeShopDomain } from "../../utils/shopDomainUtils.js";

function toIsoHourWindowStart(date = new Date()) {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

export function buildProductSyncJobId({ shopUrl, reason, windowStart, operationId = "" }) {
  const shopPart = String(shopUrl || "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_");
  const reasonPart = String(reason || "scheduled").replace(/[^a-zA-Z0-9_.-]/g, "_");
  const windowPart = String(windowStart || "unspecified").replace(/[^a-zA-Z0-9_.:-]/g, "_");
  const opPart = String(operationId || "").replace(/[^a-zA-Z0-9_.:-]/g, "_");
  return joinSafeJobId("product-sync", shopPart, reasonPart, windowPart, opPart || "no-op");
}

export async function enqueueProductSyncExecutionJob({
  shopUrl,
  syncReason = "manual",
  windowStart = toIsoHourWindowStart(),
  priority,
  delay,
  operationId = null,
}) {
  const canonicalShop = normalizeShopDomain(shopUrl);
  if (!canonicalShop) throw new Error("PRODUCT_SYNC_CANONICAL_SHOP_REQUIRED");
  const jobId = buildProductSyncJobId({
    shopUrl: canonicalShop,
    reason: syncReason,
    windowStart,
    operationId: operationId || "",
  });

  try {
    const computedPriority =
      typeof priority === "number"
        ? priority
        : syncReason === "manual"
          ? 1
          : 10;
    return await productSyncExecuteQueue.add(
      syncReason === "manual" ? "manual-product-sync" : "store-product-sync",
      { shopUrl: canonicalShop, syncReason, windowStart, operationId },
      {
        ...PRODUCT_SYNC_JOB_OPTIONS,
        priority: computedPriority,
        ...(typeof delay === "number" ? { delay } : {}),
        jobId,
      },
    );
  } catch (error) {
    if (String(error?.message || "").includes("Job already exists")) {
      return { skipped: true, reason: "duplicate_job", jobId };
    }
    throw error;
  }
}

export async function setupProductSyncCron() {
  if (process.env.NODE_ENV === "production") {
    return { skipped: true, reason: "retired_legacy_repeatable_setup" };
  }

  await productSyncSchedulerQueue.add(
    "schedule-all-product-syncs",
    {},
    {
      ...PRODUCT_SYNC_JOB_OPTIONS,
      repeat: { pattern: "0 */6 * * *" },
      jobId: "schedule-all-product-syncs",
    },
  );

  return { scheduled: true };
}

export async function seedProductSyncOperation({ shopUrl, reason, operationId }) {
  const canonicalShop = normalizeShopDomain(shopUrl);
  if (!canonicalShop) throw new Error("PRODUCT_SYNC_CANONICAL_SHOP_REQUIRED");
  const id = operationId || joinSafeJobId("product-sync-op", canonicalShop, reason, Date.now());
  const fingerprint = `${reason}:${id}`;

  // Execute single Prisma transaction for idempotency claim, sync operation, and outbox intent
  await db.$transaction(async (tx) => {
    // 1. Idempotency record
    await tx.operationFingerprint.upsert({
      where: {
        shop_operationType_fingerprint: {
          shop: canonicalShop,
          operationType: "PRODUCT_SYNC",
          fingerprint,
        },
      },
      create: {
        id,
        shop: canonicalShop,
        operationType: "PRODUCT_SYNC",
        fingerprint,
        fingerprintResourceType: "product_sync",
        resourceId: null,
        status: SYNC_STATUS_NORMALIZED.QUEUED,
        lastError: null,
      },
      update: {
        status: SYNC_STATUS_NORMALIZED.QUEUED,
        resourceId: null,
        lastError: null,
        updatedAt: new Date(),
      },
    });

    // 2. Operation row (SyncHistory)
    await tx.syncHistory.upsert({
      where: {
        shop_id: {
          shop: canonicalShop,
          id,
        },
      },
      create: {
        id,
        shop: canonicalShop,
        operationType: SYNC_OPERATION_TYPE.PRODUCT,
        status: "queued",
        stage: "QUEUED",
        duration: 0,
        recordCount: 0,
      },
      update: {
        status: "queued",
        stage: "QUEUED",
        updatedAt: new Date(),
      },
    });

    // 3. Outbox event (OperationEnqueueIntent)
    const intentPayload = { shopUrl: canonicalShop, syncReason: reason, operationId: id };
    await tx.operationEnqueueIntent.createMany({
      data: [{
        id: crypto.randomUUID(),
        shop: canonicalShop,
        queueRoutingKey: "product_sync",
        queueJobName: reason === "manual" ? "manual-product-sync" : "store-product-sync",
        dispatchScope: "product_sync",
        dispatchDedupeKey: `product_sync_${canonicalShop}_${id}`,
        payload: intentPayload,
        ...buildImmutablePayloadMetadata({ payload: intentPayload, operationType: "OPERATION_ENQUEUE_INTENT" }),
        status: "PENDING",
      }],
      skipDuplicates: true,
    });
  });

  return id;
}
