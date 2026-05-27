import crypto from "crypto";
import { connection } from "../config/redis.js";
import { recordMirrorAnomaly } from "./mirrorAnomalyService.js";
import {
  releaseRedisLock,
  renewRedisLock,
} from "../utils/redisLockUtils.js";

const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const lockHeartbeats = new Map();
export const LOCK_NS = Object.freeze({
  DEFAULT: "DEFAULT",
  WRITE_CATALOG: "WRITE_CATALOG",
  PREPARE_OPERATION: "PREPARE_OPERATION",
});

export function buildShopWorkLockKey(shop, namespace = LOCK_NS.DEFAULT) {
  if (!shop) {
    throw new Error("shop is required for exclusive shop work locking");
  }

  return `shop-exclusive-work:${namespace}:${shop}`;
}

export async function acquireExclusiveShopWork({
  shop,
  namespace = LOCK_NS.DEFAULT,
  activity,
  worker,
  queue,
  jobId = null,
  entityType = null,
  entityId = null,
  executionId = null,
}) {
  const lockKey = buildShopWorkLockKey(shop, namespace);
  const lockToken = crypto.randomUUID();
  const acquired = await connection.set(
    lockKey,
    lockToken,
    "NX",
    "PX",
    DEFAULT_LOCK_TTL_MS,
  );

  if (acquired !== "OK") {
    await recordMirrorAnomaly({
      shop,
      severity: "medium",
      type: "shop_work_conflict",
      entityType,
      entityId,
      message: `Blocked overlapping ${activity} while another heavy job was active`,
      details: { activity, worker, queue, jobId, executionId },
    }).catch(() => {});

    return { acquired: false, lockKey: null };
  }

  const leaseId = `${lockKey}:${lockToken}`;
  const heartbeat = setInterval(async () => {
    try {
      await renewRedisLock({
        connection,
        key: lockKey,
        token: lockToken,
        ttlMs: DEFAULT_LOCK_TTL_MS,
      });
    } catch (_error) {
      // Best effort lease extension; lock expires naturally if refresh fails.
    }
  }, HEARTBEAT_INTERVAL_MS);

  lockHeartbeats.set(leaseId, heartbeat);

  return { acquired: true, lockKey: leaseId };
}

export async function releaseExclusiveShopWork(lockKey) {
  if (!lockKey || typeof lockKey !== "string") return;

  const splitIndex = lockKey.lastIndexOf(":");
  if (splitIndex <= 0) return;

  const redisKey = lockKey.slice(0, splitIndex);
  const lockToken = lockKey.slice(splitIndex + 1);

  const heartbeat = lockHeartbeats.get(lockKey);
  if (heartbeat) {
    clearInterval(heartbeat);
    lockHeartbeats.delete(lockKey);
  }

  await releaseRedisLock({
    connection,
    key: redisKey,
    token: lockToken,
  }).catch(() => {});
}
