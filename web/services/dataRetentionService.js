import logger from "../utils/loggerUtils.js";
import { RETENTION_DAYS } from "./dataRetentionPolicy.js";
import fs from "node:fs/promises";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 1000;
const TERMINAL_EDIT_STATUSES = ["COMPLETED", "FAILED", "PARTIAL"];
const TERMINAL_CHANGE_STATUSES = [
  "APPLIED",
  "FAILED",
  "ROLLED_BACK",
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
    const deletedInBatch = Number(result?.count || 0);
    if (deletedInBatch <= 0) {
      throw new Error("RETENTION_PURGE_NO_PROGRESS");
    }
    deleted += deletedInBatch;
    if (rows.length < take) break;
    // eslint-disable-next-line no-await-in-loop
    await sleepFn(pauseMs);
  }

  return { deleted };
}

function cloudinaryPublicIdFromUrl(fileUrl) {
  if (!fileUrl || !/^https?:\/\//i.test(String(fileUrl))) return null;
  try {
    const url = new URL(fileUrl);
    const marker = "/upload/";
    const uploadIndex = url.pathname.indexOf(marker);
    if (uploadIndex < 0) return null;
    const afterUpload = url.pathname.slice(uploadIndex + marker.length);
    const withoutVersion = afterUpload.replace(/^v\d+\//, "");
    return decodeURIComponent(withoutVersion).replace(/\.[^/.]+$/, "");
  } catch {
    return null;
  }
}

export async function deleteStoredFileObject({ storageKey, fileUrl }) {
  const key = String(storageKey || "").trim();
  if (key) {
    const cloudinary = (await import("../config/cloudinary.js")).default;
    await cloudinary.uploader.destroy(key, { resource_type: "raw" });
    return { deleted: true, storageKey: key, provider: "cloudinary" };
  }

  const url = String(fileUrl || "").trim();
  if (!url) return { deleted: false, reason: "no_file_reference" };
  if (!/^https?:\/\//i.test(url)) {
    await fs.unlink(url).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    return { deleted: true, fileUrl: url, provider: "local" };
  }

  const publicId = cloudinaryPublicIdFromUrl(url);
  if (!publicId) return { deleted: false, reason: "unsupported_file_url" };
  const cloudinary = (await import("../config/cloudinary.js")).default;
  await cloudinary.uploader.destroy(publicId, { resource_type: "raw" });
  return { deleted: true, storageKey: publicId, provider: "cloudinary" };
}

async function purgeStoredFileRows({
  delegate,
  shop,
  where,
  dateField,
  deleteStorageObject = deleteStoredFileObject,
  batchSize = DEFAULT_BATCH_SIZE,
  pauseMs = 100,
  sleepFn = sleep,
}) {
  const take = Math.max(1, Math.min(Number(batchSize) || DEFAULT_BATCH_SIZE, 5000));
  let deleted = 0;
  let storageDeleted = 0;

  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await delegate.findMany({
      where: { shop, ...where },
      select: { id: true, storageKey: true, fileUrl: true },
      orderBy: dateField ? { [dateField]: "asc" } : { id: "asc" },
      take,
    });
    if (!rows.length) break;

    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop
      await deleteStorageObject({
        storageKey: row.storageKey,
        fileUrl: row.fileUrl,
      });
      storageDeleted += row.storageKey || row.fileUrl ? 1 : 0;
    }

    // eslint-disable-next-line no-await-in-loop
    const result = await delegate.deleteMany({
      where: {
        shop,
        id: { in: rows.map(({ id }) => id) },
      },
    });
    const deletedInBatch = Number(result?.count || 0);
    if (deletedInBatch <= 0) {
      throw new Error("RETENTION_PURGE_NO_PROGRESS");
    }
    deleted += deletedInBatch;
    if (rows.length < take) break;
    // eslint-disable-next-line no-await-in-loop
    await sleepFn(pauseMs);
  }

  return { deleted, storageDeleted };
}

export async function purgeOldChangeRecords({
  shop,
  retentionDays = RETENTION_DAYS.CHANGE_RECORD,
  db,
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
  db,
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
  db,
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

export async function purgeExpiredFilterTracks({
  shop,
  retentionDays = RETENTION_DAYS.FILTER_TRACK,
  db,
  now = new Date(),
  ...batchOptions
}) {
  const cutoff = retentionCutoff(retentionDays, now);
  const result = await purgeIdBatches({
    delegate: db.filterTrack,
    shop,
    where: {
      OR: [
        { expiresAt: { lte: now } },
        {
          expiresAt: null,
          createdAt: { lt: cutoff },
        },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    ...batchOptions,
  });
  return { ...result, cutoff };
}

export async function purgeExpiredTargetSnapshots({
  shop,
  db,
  now = new Date(),
  ...batchOptions
}) {
  return purgeIdBatches({
    delegate: db.targetSnapshot,
    shop,
    where: { purgeAfter: { lte: now } },
    dateField: "purgeAfter",
    ...batchOptions,
  });
}

export async function purgeExpiredSpreadsheetFiles({
  shop,
  db,
  now = new Date(),
  deleteStorageObject,
  ...batchOptions
}) {
  return purgeStoredFileRows({
    delegate: db.spreadsheetFile,
    shop,
    where: { storageExpiresAt: { lte: now } },
    dateField: "storageExpiresAt",
    deleteStorageObject,
    ...batchOptions,
  });
}

export async function purgeExpiredExportHistories({
  shop,
  db,
  now = new Date(),
  deleteStorageObject,
  ...batchOptions
}) {
  return purgeStoredFileRows({
    delegate: db.exportHistory,
    shop,
    where: { storageExpiresAt: { lte: now } },
    dateField: "storageExpiresAt",
    deleteStorageObject,
    ...batchOptions,
  });
}

export async function purgeExpiredOperationStageProgress({
  shop,
  db,
  now = new Date(),
  ...batchOptions
}) {
  return purgeIdBatches({
    delegate: db.operationStageProgress,
    shop,
    where: { purgeAfter: { lte: now } },
    dateField: "purgeAfter",
    ...batchOptions,
  });
}

export async function purgeExpiredMirrorAnomalies({
  shop,
  db,
  now = new Date(),
  ...batchOptions
}) {
  return purgeIdBatches({
    delegate: db.mirrorAnomaly,
    shop,
    where: { purgeAfter: { lte: now } },
    dateField: "purgeAfter",
    ...batchOptions,
  });
}

export async function purgeExpiredBillingEvents({
  shop,
  db,
  now = new Date(),
  ...batchOptions
}) {
  return purgeIdBatches({
    delegate: db.billingEvent,
    shop,
    where: { purgeAfter: { lte: now } },
    dateField: "purgeAfter",
    ...batchOptions,
  });
}

export async function purgeDispatchedOutboxEvents({
  shop,
  db,
  now = new Date(),
  ...batchOptions
}) {
  return purgeIdBatches({
    delegate: db.outboxEvent,
    shop,
    where: {
      status: "DISPATCHED",
      purgeAfter: { lte: now },
    },
    dateField: "purgeAfter",
    ...batchOptions,
  });
}

export async function purgeExpiredIdempotencyRecords({
  shop,
  db,
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
  db,
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
  db,
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
  db,
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
  db,
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
  db,
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
  db,
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
  db,
  now = new Date(),
  cleanupBatch,
  maxBatches = 10,
}) {
  const cutoff = retentionCutoff(RETENTION_DAYS.MIRROR_BATCH_GRACE, now);
  const store = await db.store.findFirst({
    where: { shopUrl: shop },
    select: {
      activeMirrorBatchId: true,
      activeCollectionBatchId: true,
    },
  });
  const [recentProductBatches, recentCollectionBatches] = await Promise.all([
    db.mirrorBatch.findMany({
      where: { shop, resourceType: "PRODUCT_CATALOG" },
      select: { id: true },
      orderBy: { createdAt: "desc" },
      take: 2,
    }),
    db.mirrorBatch.findMany({
      where: { shop, resourceType: "COLLECTION_CATALOG" },
      select: { id: true },
      orderBy: { createdAt: "desc" },
      take: 2,
    }),
  ]);
  const protectedIds = new Set([
    store?.activeMirrorBatchId,
    store?.activeCollectionBatchId,
    ...recentProductBatches.map(({ id }) => id),
    ...recentCollectionBatches.map(({ id }) => id),
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
    // Collection rows use their own mirror batch and are not part of product cleanup.
    // eslint-disable-next-line no-await-in-loop
    await purgeIdBatches({
      delegate: db.collection,
      shop,
      where: { mirrorBatchId: id },
      dateField: "createdAt",
    });
    // eslint-disable-next-line no-await-in-loop
    const result = await db.mirrorBatch.deleteMany({ where: { shop, id } });
    deleted += Number(result?.count || 0);
  }
  return { deleted, cutoff, protectedBatchIds: [...protectedIds] };
}

export async function purgeExpiredData({
  shop,
  db = null,
  serviceLogger = logger,
  now = new Date(),
  batchSize = DEFAULT_BATCH_SIZE,
  pauseMs = 100,
  sleepFn = sleep,
  cleanupBatch = null,
} = {}) {
  const scopedShop = String(shop || "").trim();
  if (!scopedShop) throw new Error("purgeExpiredData requires shop");
  const database = db || (await import("../repositories/repositoryDb.js")).db;
  const mirrorCleanup = cleanupBatch || (
    await import("../repositories/productSyncRepository.js")
  ).cleanupPreviousMirrorBatch;
  const batchOptions = { db: database, now, batchSize, pauseMs, sleepFn };

  const results = {
    mirrorBatches: await purgeRetiredMirrorBatches({
      shop: scopedShop,
      db: database,
      now,
      cleanupBatch: mirrorCleanup,
    }),
    changeRecords: await purgeOldChangeRecords({ shop: scopedShop, ...batchOptions }),
    snapshotItems: await purgeExpiredSnapshotItems({ shop: scopedShop, ...batchOptions }),
    targetSnapshots: await purgeExpiredTargetSnapshots({ shop: scopedShop, ...batchOptions }),
    webhookDeliveries: await purgeOldWebhookDeliveries({ shop: scopedShop, ...batchOptions }),
    filterTracks: await purgeExpiredFilterTracks({ shop: scopedShop, ...batchOptions }),
    spreadsheetFiles: await purgeExpiredSpreadsheetFiles({ shop: scopedShop, ...batchOptions }),
    exportHistories: await purgeExpiredExportHistories({ shop: scopedShop, ...batchOptions }),
    operationStageProgress: await purgeExpiredOperationStageProgress({
      shop: scopedShop,
      ...batchOptions,
    }),
    mirrorAnomalies: await purgeExpiredMirrorAnomalies({ shop: scopedShop, ...batchOptions }),
    billingEvents: await purgeExpiredBillingEvents({ shop: scopedShop, ...batchOptions }),
    outboxEvents: await purgeDispatchedOutboxEvents({ shop: scopedShop, ...batchOptions }),
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
