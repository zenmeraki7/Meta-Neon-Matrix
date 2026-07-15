import { Queue } from "bullmq";
import { connection } from "../../config/redis.js";

export const MIRROR_CLEANUP_QUEUE =
  process.env.NODE_ENV === "production"
    ? "mirror-cleanup"
    : "mirror-cleanup-dev";

export const mirrorCleanupQueue = new Queue(MIRROR_CLEANUP_QUEUE, {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 5_000,
    },
    removeOnComplete: {
      age: 24 * 60 * 60,
      count: 1_000,
    },
    removeOnFail: {
      age: 7 * 24 * 60 * 60,
      count: 5_000,
    },
  },
});

export async function enqueueRetiredMirrorCleanup({
  shop,
  mirrorBatchId,
}) {
  if (!shop || !mirrorBatchId) return null;

  return mirrorCleanupQueue.add(
    "cleanup-retired-product-mirror",
    { shop, mirrorBatchId },
    {
      jobId: `mirror-cleanup:${shop}:${mirrorBatchId}`,
    },
  );
}
