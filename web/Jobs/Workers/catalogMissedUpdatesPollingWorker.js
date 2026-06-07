import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { db } from "../../repositories/repositoryDb.js";
import { getSession } from "../../utils/sessionHandler.js";
import { adminGraphqlWithRetry } from "../../utils/shopifyAdminApi.js";
import { getSyncCursor, setSyncCursor } from "../../db/syncCursors.js";
import { upsertFromSync } from "../../db/variantMetafields.js";
import logger from "../../utils/loggerUtils.js";
import {
  acquireRedisLock,
  releaseRedisLock,
  renewRedisLock,
} from "../../utils/redisLockUtils.js";
import { enqueueCatalogMissedUpdatesPollingTick } from "../../queues/adapters/workerSchedulerQueueAdapter.js";

const QUEUE_NAME = process.env.CATALOG_MISSED_UPDATES_POLL_QUEUE || "catalog-missed-updates-polling";
const POLL_INTERVAL_MS = 15 * 60 * 1000;
const LEADER_LOCK_KEY = "leader:catalog-missed-updates-polling:scheduler";
const LEADER_LOCK_TTL_MS = 45_000;
const CURSOR_RESOURCE = "products";
const PAGE_SIZE = 250;
const REQUIRED_TABLES = ["sync_cursors", "variant_metafields"];
const POLL_LOCK_TTL_MS = Math.max(
  60_000,
  Number.parseInt(process.env.CATALOG_POLL_LOCK_TTL_MS || `${10 * 60 * 1000}`, 10)
    || 10 * 60 * 1000,
);
const POLL_LOCK_RENEW_MS = Math.max(10_000, Math.floor(POLL_LOCK_TTL_MS / 3));
const POLL_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.CATALOG_POLL_CONCURRENCY || "5", 10) || 5,
);
const THROTTLE_RESERVE = Math.max(
  1,
  Number.parseInt(process.env.CATALOG_POLL_THROTTLE_RESERVE || "100", 10) || 100,
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function paceForThrottle(response) {
  const throttle = response?.body?.extensions?.cost?.throttleStatus;
  const currentlyAvailable = Number(throttle?.currentlyAvailable);
  const restoreRate = Number(throttle?.restoreRate);
  if (
    !Number.isFinite(currentlyAvailable)
    || currentlyAvailable >= THROTTLE_RESERVE
    || !(restoreRate > 0)
  ) {
    return;
  }
  const waitMs = Math.min(
    10_000,
    Math.max(250, Math.ceil(((THROTTLE_RESERVE - currentlyAvailable) / restoreRate) * 1000)),
  );
  await sleep(waitMs);
}

const PRODUCTS_UPDATED_QUERY = `#graphql
  query ProductsUpdatedSince($first: Int!, $after: String, $query: String!) {
    products(first: $first, after: $after, query: $query) {
      nodes {
        id
        updatedAt
        variants(first: 250) {
          nodes {
            id
            metafields(first: 100) {
              nodes {
                id
                namespace
                key
                type
                value
                compareDigest
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

function toNumericId(gid) {
  const raw = String(gid || "").trim();
  const match = raw.match(/\/(\d+)$/);
  return match ? match[1] : null;
}

function toIsoOrNull(value) {
  if (!value) return null;
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function buildUpdatedAtQuery(cursorIso) {
  // Include a small overlap window to avoid timestamp-edge misses.
  const cursorDate = cursorIso ? new Date(cursorIso) : new Date(Date.now() - POLL_INTERVAL_MS);
  const safe = Number.isNaN(cursorDate.getTime())
    ? new Date(Date.now() - POLL_INTERVAL_MS)
    : new Date(cursorDate.getTime() - 1000);
  const stamp = safe.toISOString();
  return `updated_at:>'${stamp}'`;
}

function buildMetafieldRows(products = []) {
  const rows = [];
  for (const product of Array.isArray(products) ? products : []) {
    for (const variant of product?.variants?.nodes || []) {
      const variantId = toNumericId(variant?.id);
      if (!variantId) continue;
      for (const metafield of variant?.metafields?.nodes || []) {
        const namespace = String(metafield?.namespace || "").trim();
        const key = String(metafield?.key || "").trim();
        if (!namespace || !key) continue;
        rows.push({
          variantId,
          namespace,
          key,
          type: metafield?.type == null ? null : String(metafield.type),
          value: metafield?.value == null ? null : String(metafield.value),
          compareDigest: metafield?.compareDigest == null ? null : String(metafield.compareDigest),
          shopifyMetafieldId: metafield?.id == null ? null : String(metafield.id),
          sourceUpdatedAt: product?.updatedAt || null,
        });
      }
    }
  }
  return rows;
}

async function pollMissedUpdatesForShop(shop) {
  const cursor = await getSyncCursor(shop, CURSOR_RESOURCE);
  const queryString = buildUpdatedAtQuery(cursor);

  let after = null;
  let hasNext = true;
  let maxUpdatedAt = cursor;
  let processedProducts = 0;
  let stagedMetafields = 0;

  const session = await getSession(shop);
  while (hasNext) {
    const response = await adminGraphqlWithRetry({
      session,
      operationName: "catalog-missed-updates-poll",
      data: {
        query: PRODUCTS_UPDATED_QUERY,
        variables: {
          first: PAGE_SIZE,
          after,
          query: queryString,
        },
      },
    });

    const payload = response?.body?.data?.products || {};
    const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
    const pageInfo = payload?.pageInfo || {};

    processedProducts += nodes.length;
    const metafieldRows = buildMetafieldRows(nodes);
    if (metafieldRows.length > 0) {
      await upsertFromSync(shop, metafieldRows);
      stagedMetafields += metafieldRows.length;
    }

    for (const product of nodes) {
      const iso = toIsoOrNull(product?.updatedAt);
      if (!iso) continue;
      if (!maxUpdatedAt || iso > maxUpdatedAt) {
        maxUpdatedAt = iso;
      }
    }

    hasNext = Boolean(pageInfo?.hasNextPage);
    after = pageInfo?.endCursor || null;
    if (hasNext) {
      // adminGraphqlWithRetry handles throttled responses; this preserves budget
      // before proactively requesting the next catalog page.
      await paceForThrottle(response);
    }
  }

  await setSyncCursor(shop, CURSOR_RESOURCE, maxUpdatedAt || new Date().toISOString());
  return { shop, processedProducts, stagedMetafields, cursorBefore: cursor, cursorAfter: maxUpdatedAt };
}

async function pollMissedUpdates({ shop }) {
  const scopedShop = String(shop || "").trim();
  if (!scopedShop) {
    throw new Error("catalog missed-updates polling requires shop");
  }
  const readiness = await getPollingReadiness();
  if (!readiness.ready) {
    logger.warn("Catalog missed-updates polling skipped: required tables missing", {
      worker: "catalogMissedUpdatesPollingWorker",
      missingTables: readiness.missingTables,
    });
    return {
      skipped: true,
      reason: "required_tables_missing",
      missingTables: readiness.missingTables,
    };
  }

  const store = await db.store.findUnique({
    where: {
      shopUrl: scopedShop,
    },
    select: {
      shopUrl: true,
      accessTokenEncrypted: true,
      isUnInstalled: true,
    },
  });

  const canPoll =
    store?.shopUrl
    && !store.isUnInstalled
    && store?.accessTokenEncrypted;
  if (!canPoll) {
    return { scanned: 0, synced: 0, failed: 0, failures: [], skipped: true };
  }

  const pollLock = await acquireRedisLock({
    connection,
    key: `catalog-missed-updates-poll:${scopedShop}`,
    ttlMs: POLL_LOCK_TTL_MS,
  });
  if (!pollLock.acquired) {
    return {
      scanned: 0,
      synced: 0,
      failed: 0,
      failures: [],
      skipped: true,
      reason: "shop_poll_already_running",
    };
  }
  const renewTimer = setInterval(() => {
    void renewRedisLock({
      connection,
      key: pollLock.key,
      token: pollLock.token,
      ttlMs: POLL_LOCK_TTL_MS,
    }).catch((error) => {
      logger.error("Catalog missed-updates polling lock renewal failed", {
        worker: "catalogMissedUpdatesPollingWorker",
        shop: scopedShop,
        message: error?.message || String(error),
      });
    });
  }, POLL_LOCK_RENEW_MS);
  renewTimer.unref?.();

  let scanned = 0;
  let synced = 0;
  const failures = [];

  try {
    scanned += 1;
    await pollMissedUpdatesForShop(scopedShop);
    synced += 1;
  } catch (error) {
    failures.push({
      shop: scopedShop,
      message: error?.message || String(error),
    });
    logger.error("Catalog missed-updates polling failed for shop", {
      worker: "catalogMissedUpdatesPollingWorker",
      shop: scopedShop,
      message: error?.message || String(error),
    });
  } finally {
    clearInterval(renewTimer);
    await releaseRedisLock({
      connection,
      key: pollLock.key,
      token: pollLock.token,
    }).catch(() => {});
  }

  return { scanned, synced, failed: failures.length, failures };
}

async function getPollingReadiness() {
  const checks = await Promise.all(REQUIRED_TABLES.map(async (table) => {
    const rows = await db.$queryRaw`
      SELECT to_regclass(${`public.${table}`})::text AS regclass
    `;
    return { table, ready: Boolean(rows?.[0]?.regclass) };
  }));
  const missingTables = checks.filter((check) => !check.ready).map((check) => check.table);
  return {
    ready: missingTables.length === 0,
    missingTables,
  };
}

export const catalogMissedUpdatesPollingWorker = new Worker(
  QUEUE_NAME,
  async (job) => pollMissedUpdates({ shop: job?.data?.shop }),
  {
    connection,
    concurrency: POLL_CONCURRENCY,
  },
);

catalogMissedUpdatesPollingWorker.on("completed", (job, result) => {
  logger.info("Catalog missed-updates polling completed", {
    worker: "catalogMissedUpdatesPollingWorker",
    jobId: job?.id,
    result,
  });
});

catalogMissedUpdatesPollingWorker.on("failed", (job, error) => {
  logger.error("Catalog missed-updates polling failed", {
    worker: "catalogMissedUpdatesPollingWorker",
    jobId: job?.id,
    message: error?.message || String(error),
  });
});

catalogMissedUpdatesPollingWorker.on("stalled", (jobId) => {
  logger.warn("Catalog missed-updates polling job stalled", {
    worker: "catalogMissedUpdatesPollingWorker",
    jobId,
  });
});

export async function registerCatalogMissedUpdatesPollingTick({ shop }) {
  const scopedShop = String(shop || "").trim();
  if (!scopedShop) {
    throw new Error("catalog missed-updates polling registration requires shop");
  }
  let readiness;
  try {
    readiness = await getPollingReadiness();
  } catch (error) {
    logger.error("Catalog missed-updates polling scheduler not registered: readiness check failed", {
      worker: "catalogMissedUpdatesPollingWorker",
      message: error?.message || String(error),
    });
    return;
  }

  if (!readiness.ready) {
    logger.warn("Catalog missed-updates polling scheduler not registered: required tables missing", {
      worker: "catalogMissedUpdatesPollingWorker",
      missingTables: readiness.missingTables,
    });
    return;
  }

  const leaderLock = await acquireRedisLock({
    connection,
    key: `${LEADER_LOCK_KEY}:${scopedShop}`,
    ttlMs: LEADER_LOCK_TTL_MS,
  });
  if (!leaderLock.acquired) return;

  try {
    await enqueueCatalogMissedUpdatesPollingTick({
      queueName: QUEUE_NAME,
      shop: scopedShop,
      repeatEveryMs: POLL_INTERVAL_MS,
    });
  } finally {
    await releaseRedisLock({
      connection,
      key: leaderLock.key,
      token: leaderLock.token,
    }).catch(() => {});
  }
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await catalogMissedUpdatesPollingWorker.close();
  } catch (error) {
    logger.error("Catalog missed-updates polling worker shutdown failed", {
      worker: "catalogMissedUpdatesPollingWorker",
      signal,
      message: error?.message || String(error),
    });
  }
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

export default catalogMissedUpdatesPollingWorker;
