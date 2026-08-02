//web/privacy.js
import { DeliveryMethod } from "@shopify/shopify-api";
import { addProductCreateJob } from "./Jobs/Queues/productCreateJob.js";
import { addProductUpdateJob } from "./Jobs/Queues/productUpdateJob.js";
import { addProductDeleteJob } from "./Jobs/Queues/productDeleteJob.js";
import { addAppUninstallJob } from "./Jobs/Queues/appUninstallJob.js";
import { addbulkOperatonQueryJob } from "./Jobs/Queues/bulkOperationQueryJob.js";
import { addbulkOperatonMutationJob } from "./Jobs/Queues/bulkOperationMutationJob.js";
import { addShopSyncJob } from "./Jobs/Queues/shopSyncJob.js";
import { mapPlanKeyFromName } from "./services/SubscriptionService/SubscriptionService.js";
import { db } from "./repositories/repositoryDb.js";
import { clearKeyCaches } from "./utils/cacheUtils.js";
import logger from "./utils/loggerUtils.js";
import crypto from "crypto";
import { normalizeWebhookDeliveryStatus } from "./utils/normalizedStateUtils.js";
import { requireShopScope } from "./utils/shopScope.js";
import { executeShopRedaction } from "./services/shopRedactionService.js";
import {
  createEnqueueIntent,
  dispatchPendingEnqueueIntents,
  ENQUEUE_QUEUE_KEYS,
} from "./services/operationEnqueueIntentService.js";
import { joinSafeJobId } from "./utils/jobQueueUtils.js";
import { ShopifyBillingService } from "./services/subscription/ShopifyBillingService.js";
import { resolveBillingStateFromActiveSubscriptions } from "./services/subscriptionAuthorityService.js";
import { applyBillingReconciliation } from "./services/billingReconciliationService.js";

function safeParseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

function createPayloadHash(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload || {}))
    .digest("hex");
}

function normalizeWebhookEntityId(payload) {
  return (
    payload?.admin_graphql_api_id ||
    payload?.id ||
    payload?.inventory_item_id ||
    payload?.location_id ||
    null
  );
}

function hashStableId(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || "unknown"))
    .digest("hex")
    .slice(0, 32);
}

function buildWebhookIdentityParts({ topic, shop, webhookId, entityId }) {
  const scopedShop = requireShopScope(shop);
  return JSON.stringify({
    topic: topic || "UNKNOWN_TOPIC",
    shop: scopedShop,
    webhookId: webhookId || null,
    entityId: entityId || null,
  });
}

function buildWebhookDeliveryId({ topic, shop, webhookId, entityId }) {
  const rawIdentity = buildWebhookIdentityParts({
    topic,
    shop,
    webhookId,
    entityId,
  });

  return `wh_${hashStableId(rawIdentity)}`;
}

function buildWebhookDedupeKey({ topic, shop, webhookId, entityId }) {
  return `wh_dedupe_${hashStableId(
    buildWebhookIdentityParts({
      topic,
      shop,
      webhookId,
      entityId,
    })
  )}`;
}

export function buildWebhookJobId({ topic, shop, webhookId, entityId }) {
  const scopedShop = requireShopScope(shop);
  const raw = `${topic}:${scopedShop}:${webhookId || "none"}:${entityId || "none"}`;
  return `wh_job_${hashStableId(raw)}`;
}

async function reserveWebhookDelivery({
  tx = db,
  topic,
  shop,
  webhookId,
  entityId,
  payload,
}) {
  const id = buildWebhookDeliveryId({ topic, shop, webhookId, entityId });
  const dedupeKey = buildWebhookDedupeKey({ topic, shop, webhookId, entityId });
  const payloadHash = createPayloadHash(payload);

  try {
    await tx.webhookDelivery.create({
      data: {
        id,
        topic,
        shop,
        shopifyWebhookId: webhookId || null,
        entityId: entityId ? String(entityId) : null,
        dedupeKey,
        payloadHash,
        status: "RECEIVED",
        statusNormalized: normalizeWebhookDeliveryStatus("RECEIVED"),
        attemptCount: 1,
      },
    });

    return { accepted: true, deliveryId: id, payloadHash };
  } catch (error) {
    if (error?.code !== "P2002") throw error;

    const existing = await tx.webhookDelivery.findUnique({
      where: { shop_dedupeKey: { shop, dedupeKey } },
    });

    if (!existing) throw error;

    if (existing.payloadHash && existing.payloadHash !== payloadHash) {
      throw Object.assign(new Error("Webhook identity payload conflict"), {
        code: "WEBHOOK_PAYLOAD_CONFLICT",
      });
    }

    await tx.webhookDelivery.updateMany({
      where: { id: existing.id, shop },
      data: { attemptCount: { increment: 1 } },
    });

    return { accepted: false, duplicate: true, deliveryId: existing.id, payloadHash };
  }
}

async function markWebhookQueued(deliveryId) {
  await db.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: "QUEUED",
      statusNormalized: normalizeWebhookDeliveryStatus("QUEUED"),
      updatedAt: new Date(),
    },
  }).catch(() => {});
}

async function markWebhookProcessed(deliveryId) {
  await db.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: "PROCESSED",
      statusNormalized: normalizeWebhookDeliveryStatus("PROCESSED"),
      processedAt: new Date(),
      updatedAt: new Date(),
    },
  }).catch(() => {});
}

async function markWebhookFailed(deliveryId, error) {
  await db.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: "FAILED",
      statusNormalized: normalizeWebhookDeliveryStatus("FAILED"),
      lastError: error?.message || String(error),
      updatedAt: new Date(),
    },
  }).catch(() => {});
}

async function upsertReconcileSignal({
  tx = db,
  shop,
  entityType,
  entityId,
  topic,
  payloadHash,
  webhookId,
}) {
  if (!shop || !entityType || !entityId) return;

  const normalizedEntityId = String(entityId);

  await tx.mirrorReconcileSignal.upsert({
    where: {
      shop_entityType_entityId: {
        shop,
        entityType,
        entityId: normalizedEntityId,
      },
    },
    create: {
      shop,
      entityType,
      entityId: normalizedEntityId,
      topic,
      status: "PENDING",
      signalCount: 1,
      latestWebhookId: webhookId || null,
      latestPayloadHash: payloadHash || null,
      latestSourceEventOccurredAt: new Date(),
      latestChangeSource: topic,
      updatedAt: new Date(),
    },
    update: {
      topic,
      status: "PENDING",
      signalCount: { increment: 1 },
      latestWebhookId: webhookId || null,
      latestPayloadHash: payloadHash || null,
      latestSourceEventOccurredAt: new Date(),
      latestChangeSource: topic,
      updatedAt: new Date(),
    },
  });
}

async function queueProductWebhook({
  topic,
  shop,
  webhookId,
  payload,
  queueRoutingKey,
  queueJobName,
  producer,
  entityId,
  buildJobId,
}) {
  let deliveryId = null;

  await db.$transaction(async (tx) => {
    const reservation = await reserveWebhookDelivery({
      tx,
      topic,
      shop,
      webhookId,
      entityId,
      payload,
    });

    if (!reservation.accepted) {
      deliveryId = null;
      return;
    }

    deliveryId = reservation.deliveryId;

    await upsertReconcileSignal({
      tx,
      shop,
      entityType: "product",
      entityId,
      topic,
      payloadHash: reservation.payloadHash,
      webhookId,
    });

    const deterministicJobId = buildJobId
      ? buildJobId({ topic, shop, webhookId, entityId })
      : buildWebhookJobId({ topic, shop, webhookId, entityId });

    await createEnqueueIntent({
      tx,
      shop,
      queueRoutingKey: queueRoutingKey || topic,
      queueJobName: queueJobName || topic,
      payload: { ...payload, shop, webhookId, webhookDeliveryId: reservation.deliveryId, id: entityId },
      options: { jobId: deterministicJobId },
      dispatchDedupeKey: `webhook:${deliveryId}`,
    });

    await tx.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: "QUEUED",
        statusNormalized: normalizeWebhookDeliveryStatus("QUEUED"),
        updatedAt: new Date(),
      },
    });
  });

  if (!deliveryId) {
    return { success: true, message: "Duplicate ignored" };
  }

  try {
    const deterministicJobId = buildJobId
      ? buildJobId({ topic, shop, webhookId, entityId })
      : buildWebhookJobId({ topic, shop, webhookId, entityId });

    if (producer) {
      await producer(
        { ...payload, shop, webhookId, webhookDeliveryId: deliveryId, id: entityId },
        { jobId: deterministicJobId },
      );
    } else {
      await dispatchPendingEnqueueIntents({ shop, limit: 10 });
    }
  } catch (dispatchErr) {
    logger.warn("Immediate webhook queue publish deferred to outbox worker", {
      topic,
      shop,
      webhookId,
      error: dispatchErr.message,
    });
  }

  await clearKeyCaches(`${shop}:sync_details`);
  return { success: true, message: `${topic} queued` };
}

async function queueShopSyncWebhook({
  topic,
  shop,
  webhookId,
  entityId,
  syncType,
  entityType = "shop_scope",
  payload = {},
}) {
  let deliveryId = null;

  await db.$transaction(async (tx) => {
    const reservation = await reserveWebhookDelivery({
      tx,
      topic,
      shop,
      webhookId,
      entityId,
      payload,
    });

    if (!reservation.accepted) {
      deliveryId = null;
      return;
    }

    deliveryId = reservation.deliveryId;

    await upsertReconcileSignal({
      tx,
      shop,
      entityType,
      entityId: String(entityId || syncType || "shop"),
      topic,
      payloadHash: reservation.payloadHash,
      webhookId,
    });

    const deterministicJobId = buildWebhookJobId({
      topic,
      shop,
      webhookId,
      entityId: entityId || syncType,
    });

    await createEnqueueIntent({
      tx,
      shop,
      queueRoutingKey: ENQUEUE_QUEUE_KEYS.SHOP_SYNC,
      queueJobName: "shop-sync",
      payload: { shopDomain: shop, syncType, reason: topic },
      options: { jobId: deterministicJobId },
      dispatchDedupeKey: `webhook:${deliveryId}`,
    });

    await tx.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: "QUEUED",
        statusNormalized: normalizeWebhookDeliveryStatus("QUEUED"),
        updatedAt: new Date(),
      },
    });
  });

  if (!deliveryId) {
    return { success: true, message: "Duplicate ignored" };
  }

  try {
    const deterministicJobId = buildWebhookJobId({
      topic,
      shop,
      webhookId,
      entityId: entityId || syncType,
    });

    await addShopSyncJob(
      { shopDomain: shop, syncType, reason: topic },
      { jobId: deterministicJobId },
    );
  } catch (dispatchErr) {
    logger.warn("Immediate shop sync queue publish deferred to outbox worker", {
      topic,
      shop,
      error: dispatchErr.message,
    });
  }

  await clearKeyCaches(`${shop}:sync_details`);
  return { success: true, message: `${topic} queued` };
}

export default {
  CUSTOMERS_DATA_REQUEST: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async () => ({ success: true }),
  },

  CUSTOMERS_REDACT: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (_topic, shop, _body, webhookId) => {
      return executeShopRedaction({ shop, topic: "CUSTOMERS_REDACT", webhookId });
    },
  },

  SHOP_REDACT: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (_topic, shop, _body, webhookId) => {
      return executeShopRedaction({ shop, topic: "SHOP_REDACT", webhookId });
    },
  },

  SHOP_UPDATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (_topic, shop, body, webhookId) => {
      const payload = safeParseJson(body);
      const entityId = normalizeWebhookEntityId(payload) || shop;

      const reservation = await reserveWebhookDelivery({
        topic: "SHOP_UPDATE",
        shop,
        webhookId,
        entityId,
        payload,
      });

      if (!reservation.accepted) {
        return { success: true, message: "Duplicate ignored" };
      }

      try {
        await db.store.updateMany({
          where: { shopUrl: shop },
          data: {
            shopEmail: payload.email || undefined,
            updatedAt: new Date(),
            lastActivityAt: new Date(),
          },
        });

        await markWebhookProcessed(reservation.deliveryId);
        return { success: true, message: "Shop updated" };
      } catch (error) {
        await markWebhookFailed(reservation.deliveryId, error);
        throw error;
      }
    },
  },

  PRODUCTS_CREATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (_topic, shop, body, webhookId) => {
      const payload = safeParseJson(body);
      const productId = payload.admin_graphql_api_id;

      return queueProductWebhook({
        topic: "PRODUCTS_CREATE",
        shop,
        webhookId,
        payload,
        queueRoutingKey: ENQUEUE_QUEUE_KEYS.PRODUCT_CREATE,
        queueJobName: "product-create",
        producer: addProductCreateJob,
        entityId: productId,
        buildJobId: ({ topic, shop, webhookId, entityId }) =>
          buildWebhookJobId({ topic, shop, webhookId, entityId }),
      });
    },
  },

  PRODUCTS_DELETE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (_topic, shop, body, webhookId) => {
      const payload = safeParseJson(body);
      const productId = payload.admin_graphql_api_id || payload.id;

      return queueProductWebhook({
        topic: "PRODUCTS_DELETE",
        shop,
        webhookId,
        payload,
        queueRoutingKey: ENQUEUE_QUEUE_KEYS.PRODUCT_DELETE,
        queueJobName: "product-delete",
        producer: addProductDeleteJob,
        entityId: productId,
        buildJobId: ({ topic, shop, webhookId, entityId }) =>
          buildWebhookJobId({ topic, shop, webhookId, entityId }),
      });
    },
  },

  PRODUCTS_UPDATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (_topic, shop, body, webhookId) => {
      const payload = safeParseJson(body);
      const productId = payload.admin_graphql_api_id;

      return queueProductWebhook({
        topic: "PRODUCTS_UPDATE",
        shop,
        webhookId,
        payload,
        queueRoutingKey: ENQUEUE_QUEUE_KEYS.PRODUCT_UPDATE,
        queueJobName: "product-update",
        producer: addProductUpdateJob,
        entityId: productId,
        buildJobId: ({ topic, shop, webhookId, entityId }) =>
          buildWebhookJobId({ topic, shop, webhookId, entityId }),
      });
    },
  },

  VARIANTS_UPDATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (_topic, shop, body, webhookId) => {
      const payload = safeParseJson(body);
      const variantId = payload.admin_graphql_api_id || payload.id || null;
      const rawProductId =
        payload.product_admin_graphql_api_id ||
        payload.product_id ||
        payload.productId ||
        null;

      const productId = rawProductId
        ? (String(rawProductId).startsWith("gid://shopify/Product/")
          ? String(rawProductId)
          : `gid://shopify/Product/${rawProductId}`)
        : null;

      if (!productId) {
        return { success: true, message: "Variant update ignored (missing product id)" };
      }

      return queueProductWebhook({
        topic: "VARIANTS_UPDATE",
        shop,
        webhookId,
        payload,
        queueRoutingKey: ENQUEUE_QUEUE_KEYS.PRODUCT_UPDATE,
        queueJobName: "product-update",
        producer: (jobData, opts) => addProductUpdateJob(jobData, opts),
        entityId: productId,
        buildJobId: ({ topic, shop, webhookId, entityId }) =>
          buildWebhookJobId({ topic, shop, webhookId, entityId: variantId || entityId }),
      });
    },
  },

  COLLECTIONS_CREATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (_topic, shop, body, webhookId) => {
      const payload = safeParseJson(body);
      return queueShopSyncWebhook({
        topic: "COLLECTIONS_CREATE",
        shop,
        webhookId,
        entityId: payload.admin_graphql_api_id || payload.id,
        syncType: "collection",
        entityType: "collection",
        payload,
      });
    },
  },

  COLLECTIONS_UPDATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (_topic, shop, body, webhookId) => {
      const payload = safeParseJson(body);
      return queueShopSyncWebhook({
        topic: "COLLECTIONS_UPDATE",
        shop,
        webhookId,
        entityId: payload.admin_graphql_api_id || payload.id,
        syncType: "collection",
        entityType: "collection",
        payload,
      });
    },
  },

  COLLECTIONS_DELETE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (_topic, shop, body, webhookId) => {
      const payload = safeParseJson(body);
      return queueShopSyncWebhook({
        topic: "COLLECTIONS_DELETE",
        shop,
        webhookId,
        entityId: payload.admin_graphql_api_id || payload.id,
        syncType: "collection",
        entityType: "collection",
        payload,
      });
    },
  },

  INVENTORY_LEVELS_UPDATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (_topic, shop, body, webhookId) => {
      const payload = safeParseJson(body);
      return queueShopSyncWebhook({
        topic: "INVENTORY_LEVELS_UPDATE",
        shop,
        webhookId,
        entityId: payload.inventory_item_id || payload.location_id,
        syncType: "product",
        entityType: "inventory_item",
        payload,
      });
    },
  },

  INVENTORY_ITEMS_CREATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (_topic, shop, body, webhookId) => {
      const payload = safeParseJson(body);
      return queueShopSyncWebhook({
        topic: "INVENTORY_ITEMS_CREATE",
        shop,
        webhookId,
        entityId: payload.admin_graphql_api_id || payload.id,
        syncType: "product",
        entityType: "inventory_item",
        payload,
      });
    },
  },

  INVENTORY_ITEMS_UPDATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (_topic, shop, body, webhookId) => {
      const payload = safeParseJson(body);
      return queueShopSyncWebhook({
        topic: "INVENTORY_ITEMS_UPDATE",
        shop,
        webhookId,
        entityId: payload.admin_graphql_api_id || payload.id,
        syncType: "product",
        entityType: "inventory_item",
        payload,
      });
    },
  },

  INVENTORY_ITEMS_DELETE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (_topic, shop, body, webhookId) => {
      const payload = safeParseJson(body);
      return queueShopSyncWebhook({
        topic: "INVENTORY_ITEMS_DELETE",
        shop,
        webhookId,
        entityId: payload.admin_graphql_api_id || payload.id,
        syncType: "product",
        entityType: "inventory_item",
        payload,
      });
    },
  },

  INVENTORY_LEVELS_CONNECT: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (_topic, shop, body, webhookId) => {
      const payload = safeParseJson(body);
      return queueShopSyncWebhook({
        topic: "INVENTORY_LEVELS_CONNECT",
        shop,
        webhookId,
        entityId: payload.inventory_item_id || payload.location_id,
        syncType: "product",
        entityType: "inventory_item",
        payload,
      });
    },
  },

  INVENTORY_LEVELS_DISCONNECT: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (_topic, shop, body, webhookId) => {
      const payload = safeParseJson(body);
      return queueShopSyncWebhook({
        topic: "INVENTORY_LEVELS_DISCONNECT",
        shop,
        webhookId,
        entityId: payload.inventory_item_id || payload.location_id,
        syncType: "product",
        entityType: "inventory_item",
        payload,
      });
    },
  },

  BULK_OPERATIONS_FINISH: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (_topic, shop, body, webhookId) => {
      const payload = safeParseJson(body);
      const shopifyBulkOperationId = payload.admin_graphql_api_id || payload.id;

      const reservation = await reserveWebhookDelivery({
        topic: "BULK_OPERATIONS_FINISH",
        shop,
        webhookId,
        entityId: shopifyBulkOperationId,
        payload,
      });

      if (!reservation.accepted) {
        return { success: true, message: "Duplicate ignored" };
      }

      try {
        const jobData = {
          ...payload,
          shop,
          webhookId,
        };

        if (String(payload.type || "").toLowerCase() === "mutation") {
          await addbulkOperatonMutationJob(jobData);
        } else {
          await addbulkOperatonQueryJob(jobData);
        }

        await markWebhookQueued(reservation.deliveryId);
        await clearKeyCaches(`${shop}:sync_details`);

        return {
          success: true,
          message: "Bulk operation job queued",
        };
      } catch (error) {
        await markWebhookFailed(reservation.deliveryId, error);
        throw error;
      }
    },
  },

  APP_UNINSTALLED: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (topic, shop, body, webhookId) => {
      const payload = safeParseJson(body);

      const reservation = await reserveWebhookDelivery({
        topic,
        shop,
        webhookId,
        entityId: shop,
        payload,
      });

      if (!reservation.accepted) {
        return { success: true, message: "Duplicate ignored" };
      }

      try {
        await upsertReconcileSignal({
          shop,
          entityType: "shop_scope",
          entityId: shop,
          topic,
          payloadHash: reservation.payloadHash,
          webhookId,
        });

        await addAppUninstallJob({
          shop,
          topic,
          webhookId,
          receivedAt: new Date().toISOString(),
          body,
        });

        await markWebhookQueued(reservation.deliveryId);

        return {
          success: true,
          message: "App uninstall queued",
        };
      } catch (error) {
        await markWebhookFailed(reservation.deliveryId, error);
        throw error;
      }
    },
  },

  APP_SUBSCRIPTIONS_UPDATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async (_topic, shop, body, webhookId) => {
      const reservation = await reserveWebhookDelivery({
        topic: "APP_SUBSCRIPTIONS_UPDATE",
        shop,
        webhookId,
        entityId: shop,
        payload: safeParseJson(body),
      });

      if (!reservation.accepted) {
        return { success: true, message: "Duplicate ignored" };
      }

      try {
        // 1. Record BillingEvent for idempotency. A unique constraint on
        //    [shop, webhookId] prevents a concurrent duplicate delivery from
        //    committing the same reconciliation twice.
        try {
          await db.billingEvent.create({
            data: {
              shop,
              webhookId,
              domainEventType: "APP_SUBSCRIPTIONS_UPDATE",
              sourceSystem: "SHOPIFY_WEBHOOK",
            },
          });
        } catch (e) {
          // P2002 = unique constraint violation — already processed by a concurrent delivery.
          if (e?.code === "P2002") {
            await markWebhookProcessed(reservation.deliveryId);
            return { success: true, message: "Concurrent duplicate ignored via BillingEvent" };
          }
          throw e;
        }

        // 2. Treat the webhook only as a reconciliation signal.
        //    Fetch the current authoritative subscription set from Shopify.
        //    This guards against delayed / out-of-order webhook delivery.
        const session = await db.shopifySession.findFirst({ where: { shop } });
        if (!session) {
          // Shop is already uninstalled/redacted — nothing to reconcile.
          await markWebhookProcessed(reservation.deliveryId);
          return { success: true, message: "No session, reconciliation skipped" };
        }

        const billingService = new ShopifyBillingService(session);
        const activeSubscriptions = await billingService.getActiveSubscriptions();

        // 3. Fail-closed: FROZEN/RESTRICTED throws BILLING_RESTRICTED;
        //    multiple ACTIVE throws MULTIPLE_ACTIVE_SUBSCRIPTIONS;
        //    empty list produces FREE state (downgrade).
        const state = resolveBillingStateFromActiveSubscriptions({
          shop,
          activeSubscriptions,
        });

        // 4. CAS write — only succeeds if billingAuthorityVersion hasn't advanced.
        const existingRow = await db.subscription.findFirst({ where: { shop } });
        const { applied, reason } = await applyBillingReconciliation({
          shop,
          state,
          existingRow,
        });

        logger.info("APP_SUBSCRIPTIONS_UPDATE reconciliation", {
          shop,
          webhookId,
          status: state.status,
          planKey: state.planKey,
          applied,
          reason,
        });

        if (!applied && reason === "CAS_CONFLICT") {
          // A newer reconciliation already committed. Retry will re-fetch Shopify
          // and re-apply if still necessary.
          throw new Error("BILLING_CAS_CONFLICT");
        }

        await markWebhookProcessed(reservation.deliveryId);
        return { success: true, applied, reason };
      } catch (error) {
        await markWebhookFailed(reservation.deliveryId, error);
        logger.error("APP_SUBSCRIPTIONS_UPDATE webhook failed", {
          shop,
          webhookId,
          message: error.message,
          code: error?.code ?? null,
        });
        throw error;
      }
    },
  },
};
