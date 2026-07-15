import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { db } from "../../repositories/repositoryDb.js";
import logger from "../../utils/loggerUtils.js";
import { MIRROR_CLEANUP_QUEUE } from "../Queues/mirrorCleanupQueue.js";

const CHUNK_SIZE = Math.max(
  100,
  Math.min(
    2_000,
    Number.parseInt(process.env.MIRROR_CLEANUP_CHUNK_SIZE || "500", 10),
  ),
);

async function assertNotActive(shop, mirrorBatchId) {
  const store = await db.store.findUnique({
    where: { shopUrl: shop },
    select: { activeMirrorBatchId: true },
  });

  if (store?.activeMirrorBatchId === mirrorBatchId) {
    const error = new Error("REFUSING_TO_DELETE_ACTIVE_GENERATION");
    error.code = "REFUSING_TO_DELETE_ACTIVE_GENERATION";
    throw error;
  }
}

async function deleteByCompositeRows(model, where, select, buildDeleteWhere) {
  while (true) {
    const rows = await model.findMany({
      where,
      select,
      take: CHUNK_SIZE,
    });

    if (rows.length === 0) return;

    await model.deleteMany({
      where: buildDeleteWhere(rows),
    });
  }
}

const mirrorCleanupWorker = new Worker(
  MIRROR_CLEANUP_QUEUE,
  async (job) => {
    const shop = String(job.data?.shop || "").trim();
    const mirrorBatchId = String(job.data?.mirrorBatchId || "").trim();

    if (!shop || !mirrorBatchId) {
      throw new Error("mirror cleanup requires shop and mirrorBatchId");
    }

    await assertNotActive(shop, mirrorBatchId);

    await db.mirrorBatch.updateMany({
      where: {
        id: mirrorBatchId,
        shop,
        status: { in: ["RETIRED", "FAILED", "CLEANING"] },
      },
      data: {
        status: "CLEANING",
        cleanupStartedAt: new Date(),
      },
    });

    const deleteSimple = async (model) => {
      while (true) {
        await assertNotActive(shop, mirrorBatchId);
        const rows = await model.findMany({
          where: { shop, mirrorBatchId },
          select: { shop: true },
          take: CHUNK_SIZE,
        });
        if (rows.length === 0) break;

        // Composite-key tables do not expose a universal scalar id.
        // Bounded deleteMany by generation remains safe after active recheck.
        const result = await model.deleteMany({
          where: { shop, mirrorBatchId },
        });
        if (!result.count) break;
      }
    };

    await deleteSimple(db.inventoryLevelMirror);
    await deleteSimple(db.inventoryItemMirror);
    await deleteSimple(db.productCollection);
    await deleteSimple(db.productMediaMirror);
    await deleteSimple(db.metafieldMirror);
    await deleteSimple(db.variant);
    await deleteSimple(db.product);

    await assertNotActive(shop, mirrorBatchId);

    await db.mirrorBatch.updateMany({
      where: {
        id: mirrorBatchId,
        shop,
        status: "CLEANING",
      },
      data: {
        status: "CLEANED",
        cleanedAt: new Date(),
      },
    });

    logger.info("Retired mirror generation cleaned", {
      shop,
      mirrorBatchId,
      jobId: job.id,
    });

    return { success: true, shop, mirrorBatchId };
  },
  {
    connection,
    concurrency: 2,
  },
);

mirrorCleanupWorker.on("failed", (job, error) => {
  logger.error("Mirror cleanup worker failed", {
    jobId: job?.id,
    shop: job?.data?.shop,
    mirrorBatchId: job?.data?.mirrorBatchId,
    message: error.message,
  });
});

export default mirrorCleanupWorker;
