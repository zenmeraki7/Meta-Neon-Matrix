import {
  productSyncExecuteQueue,
  productSyncSchedulerQueue,
} from "../../queues/adapters/jobsQueueInstancesAdapter.js";
import { db } from "../../repositories/repositoryDb.js";
import {
  PRODUCT_SYNC_JOB_OPTIONS,
} from "../../queues/productSyncQueue.constants.js";
import { joinSafeJobId } from "../../utils/jobQueueUtils.js";

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
  const jobId = buildProductSyncJobId({
    shopUrl,
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
      { shopUrl, syncReason, windowStart, operationId },
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
  const id = operationId || joinSafeJobId("product-sync-op", shopUrl, reason, Date.now());
  const fingerprint = `${reason}:${id}`;
  await db.operationFingerprint.upsert({
    where: {
      shop_operationType_fingerprint: {
        shop: shopUrl,
        operationType: "PRODUCT_SYNC",
        fingerprint,
      },
    },
    create: {
      id,
      shop: shopUrl,
      operationType: "PRODUCT_SYNC",
      fingerprint,
      fingerprintResourceType: "product_sync",
      resourceId: null,
      status: "QUEUED",
      lastError: null,
    },
    update: {
      status: "QUEUED",
      resourceId: null,
      lastError: null,
      updatedAt: new Date(),
    },
  });
  return id;
}
