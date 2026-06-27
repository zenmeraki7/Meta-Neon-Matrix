import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { db } from "../../repositories/repositoryDb.js";
import { getSession } from "../../utils/sessionHandler.js";
import { adminGraphqlWithRetry } from "../../utils/shopifyAdminApi.js";
import { getSyncCursor, setSyncCursor } from "../../db/syncCursors.js";
import { upsertFromSync } from "../../db/variantMetafields.js";
import logger from "../../utils/loggerUtils.js";
import { acquireRedisLock, releaseRedisLock } from "../../utils/redisLockUtils.js";
import { enqueueCatalogMissedUpdatesPollingTick } from "../../queues/adapters/workerSchedulerQueueAdapter.js";

const QUEUE_NAME = process.env.CATALOG_MISSED_UPDATES_POLL_QUEUE || "catalog-missed-updates-polling";
const POLL_INTERVAL_MS = 15 * 60 * 1000;
const LEADER_LOCK_KEY = "leader:catalog-missed-updates-polling:scheduler";
const LEADER_LOCK_TTL_MS = 45_000;
const CURSOR_RESOURCE = "products";
const DEFAULT_PAGE_SIZE = 50;
const MAX_SAFE_PAGE_SIZE = 50;
const REQUIRED_TABLES = ["sync_cursors", "variant_metafields"];

function resolveSafePageSize(value = process.env.CATALOG_MISSED_UPDATES_PAGE_SIZE) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(parsed, MAX_SAFE_PAGE_SIZE);
}

const PAGE_SIZE = resolveSafePageSize();

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
  }

  await setSyncCursor(shop, CURSOR_RESOURCE, maxUpdatedAt || new Date().toISOString());
  return { shop, processedProducts, stagedMetafields, cursorBefore: cursor, cursorAfter: maxUpdatedAt };
}

async function pollMissedUpdates() {
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

  const stores = await db.store.findMany({
    where: {
      isUnInstalled: false,
    },
    select: {
      shopUrl: true,
      accessToken: true,
      accessTokenEncrypted: true,
    },
    take: 200,
  });

  const activeShops = stores
    .filter((store) => store?.shopUrl && (store?.accessToken || store?.accessTokenEncrypted))
    .map((store) => String(store.shopUrl));

  let scanned = 0;
  let synced = 0;
  const failures = [];

  for (const shop of activeShops) {
    scanned += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      await pollMissedUpdatesForShop(shop);
      synced += 1;
    } catch (error) {
      failures.push({
        shop,
        message: error?.message || String(error),
      });
      logger.error("Catalog missed-updates polling failed for shop", {
        worker: "catalogMissedUpdatesPollingWorker",
        shop,
        message: error?.message || String(error),
      });
    }
  }

  return { scanned, synced, failed: failures.length, failures };
}

async function getPollingReadiness() {
  const missingTables = [];
  for (const table of REQUIRED_TABLES) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await db.$queryRaw`
      SELECT to_regclass(${`public.${table}`})::text AS regclass
    `;
    if (!rows?.[0]?.regclass) {
      missingTables.push(table);
    }
  }
  return {
    ready: missingTables.length === 0,
    missingTables,
  };
}

export const catalogMissedUpdatesPollingWorker = new Worker(
  QUEUE_NAME,
  async () => pollMissedUpdates(),
  {
    connection,
    concurrency: 1,
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

async function registerRepeatableTick() {
  const readiness = await getPollingReadiness();
  if (!readiness.ready) {
    logger.warn("Catalog missed-updates polling scheduler not registered: required tables missing", {
      worker: "catalogMissedUpdatesPollingWorker",
      missingTables: readiness.missingTables,
    });
    return;
  }

  const leaderLock = await acquireRedisLock({
    connection,
    key: LEADER_LOCK_KEY,
    ttlMs: LEADER_LOCK_TTL_MS,
  });
  if (!leaderLock.acquired) return;

  try {
    await enqueueCatalogMissedUpdatesPollingTick({
      queueName: QUEUE_NAME,
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

await registerRepeatableTick().catch((error) => {
  logger.error("Catalog missed-updates polling scheduler registration failed", {
    worker: "catalogMissedUpdatesPollingWorker",
    message: error?.message || String(error),
  });
});

export default catalogMissedUpdatesPollingWorker;

