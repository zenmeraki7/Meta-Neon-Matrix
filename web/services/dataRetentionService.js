import { db as defaultDb } from "../repositories/repositoryDb.js";
import logger from "../utils/loggerUtils.js";
import { cleanupPreviousMirrorBatch } from "../repositories/productSyncRepository.js";
import { RETENTION_DAYS } from "./dataRetentionPolicy.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 1000;
const TERMINAL_EDIT_STATUSES = ["COMPLETED", "FAILED", "PARTIAL"];
const TERMINAL_CHANGE_STATUSES = [
  "APPLIED",
  "FAILED",
  "ROLLED_BACK",
  "applied",
  "failed",
  "rolled_back",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function retentionCutoff(days, now = new Date()) {
  return new Date(now.getTime() - Number(days) * DAY_MS);
}

async function purgeIdBatches({
  delegate,
  shop,
  where,
  orderBy,
  dateField,
  batchSize = DEFAULT_BATCH_SIZE,
  pauseMs = 100,
  sleepFn = sleep,
}) {
  const take = Math.max(1, Math.min(Number(batchSize) || DEFAULT_BATCH_SIZE, 5000));
  let deleted = 0;

  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await delegate.findMany({
      where: { shop, ...where },
      select: { id: true },
      orderBy: orderBy || (dateField ? { [dateField]: "asc" } : { id: "asc" }),
      take,
    });
    if (!rows.length) break;

    // eslint-disable-next-line no-await-in-loop
    const result = await delegate.deleteMany({
      where: {
        shop,
        id: { in: rows.map(({ id }) => id) },
      },
    });
    deleted += Number(result?.count || 0);
    if (rows.length < take) break;
    // eslint-disable-next-line no-await-in-loop
    await sleepFn(pauseMs);
  }

  return { deleted };
}

export async function purgeOldChangeRecords({
  shop,
  retentionDays = RETENTION_DAYS.CHANGE_RECORD,
  db = defaultDb,
  now = new Date(),
  ...batchOptions
}) {
  const cutoff = retentionCutoff(retentionDays, now);
  const result = await purgeIdBatches({
    delegate: db.changeRecord,
    shop,
    where: {
      createdAt: { lt: cutoff },
      status: { in: TERMINAL_CHANGE_STATUSES },
      editHistory: {
        statusNormalized: { in: TERMINAL_EDIT_STATUSES },
      },
    },
    dateField: "createdAt",
    ...batchOptions,
  });
  return { ...result, cutoff };
}

export async function purgeExpiredSnapshotItems({
  shop,
  retentionDays = RETENTION_DAYS.TARGET_SNAPSHOT_ITEM,
  db = defaultDb,
  now = new Date(),
  ...batchOptions
}) {
  const cutoff = retentionCutoff(retentionDays, now);
  const result = await purgeIdBatches({
    delegate: db.targetSnapshotItem,
    shop,
    where: {
      createdAt: { lt: cutoff },
      executionStatus: { in: ["SUCCEEDED", "FAILED", "SKIPPED", "VERIFIED"] },
      snapshotSet: {
        OR: [
          { expiresAt: { lte: now } },
          {
            editHistories: {
              some: {
                statusNormalized: { in: TERMINAL_EDIT_STATUSES },
                completedAt: { lt: cutoff },
              },
            },
          },
        ],
      },
    },
    dateField: "createdAt",
    ...batchOptions,
  });
  return { ...result, cutoff };
}

export async function purgeOldWebhookDeliveries({
  shop,
  retentionDays = RETENTION_DAYS.WEBHOOK_DELIVERY,
  db = defaultDb,
  now = new Date(),
  ...batchOptions
}) {
  const cutoff = retentionCutoff(retentionDays, now);
  const result = await purgeIdBatches({
    delegate: db.webhookDelivery,
    shop,
    where: { createdAt: { lt: cutoff } },
    dateField: "createdAt",
    ...batchOptions,
  });
  return { ...result, cutoff };
}

export async function purgeExpiredIdempotencyRecords({
  shop,
  db = defaultDb,
  now = new Date(),
  ...batchOptions
}) {
  return purgeIdBatches({
    delegate: db.idempotencyRecord,
    shop,
    where: { expiresAt: { lte: now } },
    dateField: "expiresAt",
    ...batchOptions,
  });
}

export async function purgeExpiredLeases({
  shop,
  db = defaultDb,
  now = new Date(),
  ...batchOptions
}) {
  return purgeIdBatches({
    delegate: db.operationLease,
    shop,
    where: {
      OR: [
        { releasedAt: { not: null } },
        { expiresAt: { lte: now } },
      ],
    },
    dateField: "expiresAt",
    ...batchOptions,
  });
}

export async function purgeOldErrorLogs({
  shop,
  retentionDays = RETENTION_DAYS.ERROR_LOG,
  db = defaultDb,
  now = new Date(),
  ...batchOptions
}) {
  const cutoff = retentionCutoff(retentionDays, now);
  const result = await purgeIdBatches({
    delegate: db.errorLog,
    shop,
    where: { createdAt: { lt: cutoff } },
    dateField: "createdAt",
    ...batchOptions,
  });
  return { ...result, cutoff };
}

export async function purgeOldDeadLetterJobs({
  shop,
  retentionDays = RETENTION_DAYS.DEAD_LETTER_JOB,
  db = defaultDb,
  now = new Date(),
  ...batchOptions
}) {
  const cutoff = retentionCutoff(retentionDays, now);
  const result = await purgeIdBatches({
    delegate: db.deadLetterJob,
    shop,
    where: { failedAt: { lt: cutoff } },
    dateField: "failedAt",
    ...batchOptions,
  });
  return { ...result, cutoff };
}

export async function purgeProcessedReconcileSignals({
  shop,
  retentionHours = RETENTION_DAYS.RECONCILE_SIGNAL_HOURS,
  db = defaultDb,
  now = new Date(),
  ...batchOptions
}) {
  const cutoff = new Date(now.getTime() - Number(retentionHours) * 60 * 60 * 1000);
  const result = await purgeIdBatches({
    delegate: db.mirrorReconcileSignal,
    shop,
    where: {
      status: { in: ["processed", "reconciled", "completed", "ignored"] },
      updatedAt: { lt: cutoff },
    },
    dateField: "updatedAt",
    ...batchOptions,
  });
  return { ...result, cutoff };
}

export async function purgeOldBulkSubmissions({
  shop,
  retentionDays = RETENTION_DAYS.BULK_SUBMISSION,
  db = defaultDb,
  now = new Date(),
  ...batchOptions
}) {
  const cutoff = retentionCutoff(retentionDays, now);
  const result = await purgeIdBatches({
    delegate: db.bulkSubmission,
    shop,
    where: { processedAt: { lt: cutoff } },
    dateField: "processedAt",
    ...batchOptions,
  });
  return { ...result, cutoff };
}

export async function purgeOldEditHistories({
  shop,
  retentionDays = RETENTION_DAYS.EDIT_HISTORY,
  db = defaultDb,
  now = new Date(),
  ...batchOptions
}) {
  const cutoff = retentionCutoff(retentionDays, now);
  const result = await purgeIdBatches({
    delegate: db.editHistory,
    shop,
    where: {
      statusNormalized: { in: TERMINAL_EDIT_STATUSES },
      completedAt: { lt: cutoff },
      changeRecords: { none: {} },
      undoOperations: { none: {} },
      ingestionCheckpoints: { none: {} },
      recoveryAudits: { none: {} },
    },
    dateField: "completedAt",
    ...batchOptions,
  });
  return { ...result, cutoff };
}

export async function purgeRetiredMirrorBatches({
  shop,
  db = defaultDb,
  now = new Date(),
  cleanupBatch = cleanupPreviousMirrorBatch,
  maxBatches = 10,
}) {
  const cutoff = retentionCutoff(RETENTION_DAYS.MIRROR_BATCH_GRACE, now);
  const store = await db.store.findFirst({
    where: { shopUrl: shop },
    select: { activeMirrorBatchId: true },
  });
  const recent = await db.mirrorBatch.findMany({
    where: { shop },
    select: { id: true },
    orderBy: { createdAt: "desc" },
    take: 2,
  });
  const protectedIds = new Set([
    store?.activeMirrorBatchId,
    ...recent.map(({ id }) => id),
  ].filter(Boolean));
  const candidates = await db.mirrorBatch.findMany({
    where: {
      shop,
      createdAt: { lt: cutoff },
      status: { in: ["RETIRED", "FAILED"] },
      id: { notIn: [...protectedIds] },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(Number(maxBatches) || 10, 50)),
  });

  let deleted = 0;
  for (const { id } of candidates) {
    // Existing cleanup removes product rows in bounded chunks and dependent mirror rows.
    // eslint-disable-next-line no-await-in-loop
    await cleanupBatch({ shop, previousBatchId: id });
    // eslint-disable-next-line no-await-in-loop
    const result = await db.mirrorBatch.deleteMany({ where: { shop, id } });
    deleted += Number(result?.count || 0);
  }
  return { deleted, cutoff, protectedBatchIds: [...protectedIds] };
}

export async function purgeExpiredData({
  shop,
  db = defaultDb,
  serviceLogger = logger,
  now = new Date(),
  batchSize = DEFAULT_BATCH_SIZE,
  pauseMs = 100,
  sleepFn = sleep,
  cleanupBatch = cleanupPreviousMirrorBatch,
} = {}) {
  const scopedShop = String(shop || "").trim();
  if (!scopedShop) throw new Error("purgeExpiredData requires shop");
  const batchOptions = { db, now, batchSize, pauseMs, sleepFn };

  const results = {
    mirrorBatches: await purgeRetiredMirrorBatches({
      shop: scopedShop,
      db,
      now,
      cleanupBatch,
    }),
    changeRecords: await purgeOldChangeRecords({ shop: scopedShop, ...batchOptions }),
    snapshotItems: await purgeExpiredSnapshotItems({ shop: scopedShop, ...batchOptions }),
    webhookDeliveries: await purgeOldWebhookDeliveries({ shop: scopedShop, ...batchOptions }),
    idempotencyRecords: await purgeExpiredIdempotencyRecords({
      shop: scopedShop,
      ...batchOptions,
    }),
    leases: await purgeExpiredLeases({ shop: scopedShop, ...batchOptions }),
    errorLogs: await purgeOldErrorLogs({ shop: scopedShop, ...batchOptions }),
    deadLetterJobs: await purgeOldDeadLetterJobs({ shop: scopedShop, ...batchOptions }),
    reconcileSignals: await purgeProcessedReconcileSignals({
      shop: scopedShop,
      ...batchOptions,
    }),
    bulkSubmissions: await purgeOldBulkSubmissions({ shop: scopedShop, ...batchOptions }),
    editHistories: await purgeOldEditHistories({ shop: scopedShop, ...batchOptions }),
  };

  serviceLogger.info("NIGHTLY_PURGE_COMPLETE", {
    shop: scopedShop,
    results,
  });
  return results;
}
