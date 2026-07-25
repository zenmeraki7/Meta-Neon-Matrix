import { Queue } from "bullmq";
import { connection as redis } from "../config/redis.js";

export const applyQueue = new Queue("bulk-apply", {
  connection: redis,
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
