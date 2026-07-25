// app/queues/applyQueue.ts
import { Queue, type ConnectionOptions } from "bullmq";
import { connection as redis } from "../config/redis.js";

export const applyQueue = new Queue("bulk-apply", {
  // The app and BullMQ install compatible ioredis versions whose private
  // members make their TypeScript identities nominally incompatible.
  connection: redis as unknown as ConnectionOptions,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 2_000,
    },
    removeOnComplete: 1_000,
    removeOnFail: 5_000,
  },
});
