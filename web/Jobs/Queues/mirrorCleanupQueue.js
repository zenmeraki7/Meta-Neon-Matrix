import { connection } from "../../config/redis.js";

let QueueClass = null;

try {
  const bullmq = await import("bullmq");
  QueueClass = bullmq.Queue;
} catch {
  QueueClass = class DummyQueue {
    constructor(name) {
      this.name = name;
    }
    async add() {
      return { id: "dummy_mirror_cleanup_job" };
    }
  };
}

export const MIRROR_CLEANUP_QUEUE =
  process.env.NODE_ENV === "production"
    ? "mirror-cleanup"
    : "mirror-cleanup-dev";

export const mirrorCleanupQueue = new QueueClass(MIRROR_CLEANUP_QUEUE, {
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
