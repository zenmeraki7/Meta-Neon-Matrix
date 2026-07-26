import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { db } from "../../repositories/repositoryDb.js";
import { getSession } from "../../utils/sessionHandler.js";
import { adminGraphqlWithRetry } from "../../utils/shopifyAdminApi.js";
import { getSyncCursor, setSyncCursor } from "../../db/syncCursors.js";
import logger from "../../utils/loggerUtils.js";
import { acquireRedisLock, releaseRedisLock } from "../../utils/redisLockUtils.js";
import { enqueueCatalogMissedUpdatesPollingTick } from "../../queues/adapters/workerSchedulerQueueAdapter.js";

const QUEUE_NAME = process.env.CATALOG_MISSED_UPDATES_POLL_QUEUE || "catalog-missed-updates-polling";
const POLL_INTERVAL_MS = 15 * 60 * 1000;
const LEADER_LOCK_KEY = "leader:catalog-missed-updates-polling:scheduler";
const LEADER_LOCK_TTL_MS = 45_000;
const CURSOR_RESOURCE = "products";
const PAGE_SIZE = Math.min(Math.max(Number.parseInt(process.env.CATALOG_MISSED_UPDATES_PAGE_SIZE || "50", 10), 1), 50);

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
              nodes { id namespace key type value compareDigest }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

function buildUpdatedAtQuery(cursorIso) {
  const cursor = cursorIso ? new Date(cursorIso) : new Date(Date.now() - POLL_INTERVAL_MS);
  const safe = Number.isNaN(cursor.getTime()) ? new Date(Date.now() - POLL_INTERVAL_MS) : new Date(cursor.getTime() - 1000);
  return `updated_at:>'${safe.toISOString()}'`;
}

function parseTyped(type, value) {
  const text = value == null ? null : String(value);
  const normalized = text == null ? null : text.trim().toLowerCase();
  const numberTypes = new Set(["number_integer", "number_decimal", "rating", "money"]);
  const numeric = text != null && numberTypes.has(type) && Number.isFinite(Number(text)) ? String(Number(text)) : null;
  const bool = normalized === "true" ? true : normalized === "false" ? false : null;
  const date = text && ["date", "date_time"].includes(type) && !Number.isNaN(Date.parse(text)) ? new Date(text) : null;
  return { text, normalized, numeric, bool, date };
}

async function applyCanonicalMetafields(shop, products) {
  const store = await db.store.findUnique({ where: { shopUrl: shop }, select: { currentProductMirrorBatchId: true } });
  const mirrorBatchId = store?.currentProductMirrorBatchId;
  if (!mirrorBatchId) return 0;

  const rows = [];
  const mutationsByProduct = new Map();
  for (const product of products) {
    for (const variant of product?.variants?.nodes || []) {
      for (const metafield of variant?.metafields?.nodes || []) {
        if (!variant?.id || !metafield?.namespace || !metafield?.key) continue;
        const typed = parseTyped(String(metafield.type || ""), metafield.value);
        rows.push({
          ownerId: variant.id,
          namespace: metafield.namespace,
          key: metafield.key,
          valueType: metafield.type || null,
          valueText: typed.text,
          valueTextNormalized: typed.normalized,
          valueNumber: typed.numeric,
          valueBoolean: typed.bool,
          valueDate: typed.date?.toISOString() || null,
        });
        const mutation = mutationsByProduct.get(product.id) || {
          productId: product.id,
          sourceEventOccurredAt: product.updatedAt || new Date().toISOString(),
          changedKeys: [],
        };
        mutation.changedKeys.push(`${metafield.namespace}.${metafield.key}`);
        mutationsByProduct.set(product.id, mutation);
      }
    }
  }
  if (rows.length === 0) return 0;
  if (rows.length > 1000 || mutationsByProduct.size > 250) {
    throw new Error("Catalog polling mutation batch exceeds the bounded transaction limit");
  }

  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "MetafieldMirror" (
        "shop", "ownerType", "ownerId", "namespace", "key", "mirrorBatchId",
        "valueType", "valueText", "valueTextNormalized", "valueNumber",
        "valueBoolean", "valueDate", "createdAt", "updatedAt"
      )
      SELECT ${shop}, 'VARIANT', row."ownerId", row."namespace", row."key", ${mirrorBatchId},
             row."valueType", row."valueText", row."valueTextNormalized",
             row."valueNumber"::numeric, row."valueBoolean", row."valueDate"::timestamp,
             ${now}, ${now}
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS row(
        "ownerId" text, "namespace" text, "key" text, "valueType" text,
        "valueText" text, "valueTextNormalized" text, "valueNumber" text,
        "valueBoolean" boolean, "valueDate" text
      )
      ON CONFLICT ("shop", "ownerType", "ownerId", "namespace", "key", "mirrorBatchId")
      DO UPDATE SET
        "valueType" = EXCLUDED."valueType", "valueText" = EXCLUDED."valueText",
        "valueTextNormalized" = EXCLUDED."valueTextNormalized", "valueNumber" = EXCLUDED."valueNumber",
        "valueBoolean" = EXCLUDED."valueBoolean", "valueDate" = EXCLUDED."valueDate",
        "updatedAt" = EXCLUDED."updatedAt"
    `;

    await tx.$executeRaw`
      WITH mutations AS (
        SELECT row."productId", row."sourceEventOccurredAt"::timestamp AS "sourceEventOccurredAt", row."changedKeys"
        FROM jsonb_to_recordset(${JSON.stringify([...mutationsByProduct.values()])}::jsonb)
          AS row("productId" text, "sourceEventOccurredAt" text, "changedKeys" jsonb)
      ), inserted AS (
        INSERT INTO "MirrorMutationJournal" (
          "shop", "entityType", "entityId", "productId", "mutationType",
          "payload", "sourceEventAt", "createdAt"
        )
        SELECT ${shop}, 'PRODUCT', "productId", "productId", 'METAFIELDS_RECONCILED',
               jsonb_build_object('changedKeys', "changedKeys", 'count', jsonb_array_length("changedKeys")),
               "sourceEventOccurredAt", ${now}
        FROM mutations
        RETURNING "productId", "sequence"
      )
      UPDATE "MirrorReconcileSignal" signal
      SET "mutationSequence" = inserted."sequence", "status" = 'PENDING'::"MirrorReconcileSignalStatus", "updatedAt" = ${now}
      FROM inserted
      WHERE signal."shop" = ${shop} AND signal."entityType" = 'product'
        AND signal."entityId" = inserted."productId"
    `;
  }, { maxWait: 10000, timeout: 60000 });
  return rows.length;
}

async function pollShop(shop) {
  const cursor = await getSyncCursor(shop, CURSOR_RESOURCE);
  const session = await getSession(shop);
  let after = null;
  let hasNextPage = true;
  let maxUpdatedAt = cursor;
  let processedProducts = 0;
  let metafields = 0;

  while (hasNextPage) {
    const response = await adminGraphqlWithRetry({
      session,
      shop,
      commandType: "catalog-missed-updates-poll",
      data: { query: PRODUCTS_UPDATED_QUERY, variables: { first: PAGE_SIZE, after, query: buildUpdatedAtQuery(cursor) } },
    });
    const errors = response?.body?.errors || [];
    if (errors.length) throw new Error(errors.map((item) => item.message).join("; "));
    const products = response?.body?.data?.products?.nodes || [];
    processedProducts += products.length;
    metafields += await applyCanonicalMetafields(shop, products);
    for (const product of products) {
      if (product?.updatedAt && (!maxUpdatedAt || product.updatedAt > maxUpdatedAt)) maxUpdatedAt = product.updatedAt;
    }
    const pageInfo = response?.body?.data?.products?.pageInfo || {};
    hasNextPage = Boolean(pageInfo.hasNextPage);
    after = pageInfo.endCursor || null;
  }

  await setSyncCursor(shop, CURSOR_RESOURCE, maxUpdatedAt || new Date().toISOString());
  return { shop, processedProducts, metafields };
}

async function pollAll() {
  const stores = await db.store.findMany({
    where: { installationStatus: "INSTALLED" },
    select: { shopUrl: true, accessTokenEncrypted: true },
    take: 200,
  });
  const results = [];
  for (const store of stores) {
    if (!store.shopUrl || !store.accessTokenEncrypted) continue;
    try { results.push(await pollShop(store.shopUrl)); }
    catch (error) { logger.error("Catalog missed-updates polling failed for shop", { shop: store.shopUrl, message: error.message }); }
  }
  return { scanned: stores.length, results };
}

export const catalogMissedUpdatesPollingWorker = new Worker(QUEUE_NAME, pollAll, { connection, concurrency: 1 });
catalogMissedUpdatesPollingWorker.on("failed", (job, error) => logger.error("Catalog missed-updates polling failed", { jobId: job?.id, message: error.message }));

async function registerRepeatableTick() {
  const lock = await acquireRedisLock({ connection, key: LEADER_LOCK_KEY, ttlMs: LEADER_LOCK_TTL_MS });
  if (!lock.acquired) return;
  try { await enqueueCatalogMissedUpdatesPollingTick({ queueName: QUEUE_NAME, repeatEveryMs: POLL_INTERVAL_MS }); }
  finally { await releaseRedisLock({ connection, key: lock.key, token: lock.token }).catch(() => {}); }
}

await registerRepeatableTick().catch((error) => logger.error("Catalog polling scheduler registration failed", { message: error.message }));
export default catalogMissedUpdatesPollingWorker;
