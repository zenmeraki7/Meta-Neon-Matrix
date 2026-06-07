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

function parseOptionalDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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
  const rawIdentity =
    webhookId ||
    buildWebhookIdentityParts({
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

function buildBusinessWebhookDedupeKey(value) {
  return `wh_dedupe_${hashStableId(value)}`;
}

async function reserveWebhookDelivery({
  topic,
  shop,
  webhookId,
  entityId,
  payload,
  businessDedupeKey = null,
}) {
  const id = buildWebhookDeliveryId({ topic, shop, webhookId, entityId });
  const dedupeKey = businessDedupeKey
    ? buildBusinessWebhookDedupeKey(businessDedupeKey)
    : buildWebhookDedupeKey({ topic, shop, webhookId, entityId });
  const payloadHash = createPayloadHash(payload);

  try {
    const existing = await db.webhookDelivery.findUnique({
      where: { dedupeKey },
      select: {
        id: true,
        status: true,
        payloadHash: true,
      },
    });

    if (existing) {
     await db.webhookDelivery
  .update({
    where: { dedupeKey },
    data: {
      attemptCount: { increment: 1 },
      updatedAt: new Date(),
    },
  })
  .catch(() => {});

      return {
        accepted: false,
        deliveryId: existing.id,
        payloadHash,
      };
    }

    await db.webhookDelivery.create({
      data: {
        id,
        topic,
        shop,
        webhookId: webhookId || null,
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
    logger.error("Webhook reservation failed", {
      topic,
      shop,
      webhookId,
      entityId,
      message: error.message,
    });

    return { accepted: false, deliveryId: id, payloadHash };
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
  shop,
  entityType,
  entityId,
  topic,
  payloadHash,
  webhookId,
  sourceUpdatedAt = null,
}) {
  if (!shop || !entityType || !entityId) return;

  const normalizedEntityId = String(entityId);
  const now = new Date();
  const sourceTimestamp = parseOptionalDate(sourceUpdatedAt);

  const signalId = `mrs_${hashStableId(
    JSON.stringify({
      shop,
      entityType,
      entityId: normalizedEntityId,
    })
  )}`;

  const where = {
    shop_entityType_entityId: {
      shop,
      entityType,
      entityId: normalizedEntityId,
    },
  };

  try {
    await db.mirrorReconcileSignal.create({
      data: {
        id: signalId,
        shop,
        entityType,
        entityId: normalizedEntityId,
        topic,
        status: "pending",
        signalCount: 1,
        latestWebhookId: sourceTimestamp ? webhookId || null : null,
        latestPayloadHash: sourceTimestamp ? payloadHash || null : null,
        latestEventAt: sourceTimestamp,
        latestSourceUpdatedAt: sourceTimestamp,
        latestSourceKind: sourceTimestamp ? topic : null,
        updatedAt: now,
      },
    });
    return;
  } catch (error) {
    if (error?.code !== "P2002") throw error;
  }

  await db.mirrorReconcileSignal.update({
    where,
    data: {
      status: "pending",
      signalCount: { increment: 1 },
      updatedAt: now,
    },
  });

  if (!sourceTimestamp) return;

  await db.mirrorReconcileSignal.updateMany({
    where: {
      shop,
      entityType,
      entityId: normalizedEntityId,
      OR: [
        { latestSourceUpdatedAt: null },
        { latestSourceUpdatedAt: { lt: sourceTimestamp } },
      ],
    },
    data: {
      topic,
      latestWebhookId: webhookId || null,
      latestPayloadHash: payloadHash || null,
      latestEventAt: sourceTimestamp,
      latestSourceUpdatedAt: sourceTimestamp,
      latestSourceKind: topic,
      updatedAt: now,
    },
  });
}

async function queueProductWebhook({
  topic,
  shop,
  webhookId,
  payload,
  producer,
  entityId,
}) {
  const businessDedupeKey = topic === "PRODUCTS_UPDATE"
    ? JSON.stringify({
      topic,
      shop: requireShopScope(shop),
      productId: String(entityId || ""),
      updatedAt: payload?.updated_at || null,
    })
    : null;

  const reservation = await reserveWebhookDelivery({
    topic,
    shop,
    webhookId,
    entityId,
    payload,
    businessDedupeKey,
  });

  if (!reservation.accepted) {
    return { success: true, message: "Duplicate ignored" };
  }

  try {
    await upsertReconcileSignal({
      shop,
      entityType: "product",
      entityId,
      topic,
      payloadHash: reservation.payloadHash,
      webhookId,
      sourceUpdatedAt: payload?.updated_at,
    });

    await producer({
      ...payload,
      shop,
      webhookId,
      id: entityId,
    });

    await markWebhookQueued(reservation.deliveryId);
    await clearKeyCaches(`${shop}:sync_details`);

    return { success: true, message: `${topic} queued` };
  } catch (error) {
    await markWebhookFailed(reservation.deliveryId, error);
    throw error;
  }
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
  const reservation = await reserveWebhookDelivery({
    topic,
    shop,
    webhookId,
    entityId,
    payload,
  });

  if (!reservation.accepted) {
    return { success: true, message: "Duplicate ignored" };
  }

  try {
    await upsertReconcileSignal({
      shop,
      entityType,
      entityId: String(entityId || syncType || "shop"),
      topic,
      payloadHash: reservation.payloadHash,
      webhookId,
      sourceUpdatedAt: payload?.updated_at,
    });

    await addShopSyncJob({
      shop,
      syncType,
      reason: topic,
    });

    await markWebhookQueued(reservation.deliveryId);
    await clearKeyCaches(`${shop}:sync_details`);

    return { success: true, message: `${topic} queued` };
  } catch (error) {
    await markWebhookFailed(reservation.deliveryId, error);
    throw error;
  }
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
    callback: async () => ({ success: true }),
  },

  SHOP_REDACT: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: "/api/webhooks",
    callback: async () => ({ success: true }),
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
        producer: addProductCreateJob,
        entityId: productId,
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
        producer: addProductDeleteJob,
        entityId: productId,
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
        producer: addProductUpdateJob,
        entityId: productId,
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

      const reservation = await reserveWebhookDelivery({
        topic: "VARIANTS_UPDATE",
        shop,
        webhookId,
        entityId: variantId || productId,
        payload,
      });

      if (!reservation.accepted) {
        return { success: true, message: "Duplicate ignored" };
      }

      try {
        await upsertReconcileSignal({
          shop,
          entityType: "product",
          entityId: productId,
          topic: "VARIANTS_UPDATE",
          payloadHash: reservation.payloadHash,
          webhookId,
          sourceUpdatedAt: payload?.updated_at,
        });

        await addProductUpdateJob(
          {
            ...payload,
            shop,
            webhookId,
            id: productId,
          },
          {
            jobId: `product-update:${shop}:${productId}`,
          },
        );

        await markWebhookQueued(reservation.deliveryId);
        await clearKeyCaches(`${shop}:sync_details`);

        return { success: true, message: "VARIANTS_UPDATE queued" };
      } catch (error) {
        await markWebhookFailed(reservation.deliveryId, error);
        throw error;
      }
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
      const bulkOperationId = payload.admin_graphql_api_id || payload.id;

      const reservation = await reserveWebhookDelivery({
        topic: "BULK_OPERATIONS_FINISH",
        shop,
        webhookId,
        entityId: bulkOperationId,
        payload,
        businessDedupeKey: JSON.stringify({
          topic: "BULK_OPERATIONS_FINISH",
          shop: requireShopScope(shop),
          bulkOperationId: String(bulkOperationId || ""),
        }),
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
          sourceUpdatedAt: payload?.updated_at,
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
      const payload = safeParseJson(body);
      const sub = payload.app_subscription;

      const reservation = await reserveWebhookDelivery({
        topic: "APP_SUBSCRIPTIONS_UPDATE",
        shop,
        webhookId,
        entityId: sub?.admin_graphql_api_id || shop,
        payload,
      });

      if (!reservation.accepted) {
        return { success: true, message: "Duplicate ignored" };
      }

      try {
        if (!sub) {
          await markWebhookProcessed(reservation.deliveryId);
          return { success: true };
        }

        const incomingSubId = sub.admin_graphql_api_id;
        const existing = await db.subscription.findFirst({
          where: { shop },
        });

        const toDateOrNull = (value) => (value ? new Date(value) : null);

        if (sub.status === "ACTIVE") {
          const isPendingApproval =
            existing?.pendingSubscriptionId === incomingSubId;

          if (isPendingApproval && existing) {
            await db.subscription.updateMany({
              where: { shop },
              data: {
                status: "ACTIVE",
                subscriptionId: incomingSubId,
                planKey: existing.pendingPlanKey,
                planName: existing.pendingPlanName || sub.name,
                currentPeriodEnd: toDateOrNull(sub.current_period_end),
                trialEndsAt: toDateOrNull(sub.trial_ends_at),
                pendingSubscriptionId: null,
                pendingPlanKey: null,
                pendingPlanName: null,
              },
            });
          } else {
            const planKey = mapPlanKeyFromName(sub.name);

            if (existing) {
              await db.subscription.updateMany({
                where: { shop },
                data: {
                  status: "ACTIVE",
                  subscriptionId: incomingSubId,
                  planKey,
                  planName: sub.name,
                  currentPeriodEnd: toDateOrNull(sub.current_period_end),
                  trialEndsAt: toDateOrNull(sub.trial_ends_at),
                },
              });
            } else {
              await db.subscription.create({
                data: {
                  shop,
                  status: "ACTIVE",
                  subscriptionId: incomingSubId,
                  planKey,
                  planName: sub.name,
                  currentPeriodEnd: toDateOrNull(sub.current_period_end),
                  trialEndsAt: toDateOrNull(sub.trial_ends_at),
                },
              });
            }
          }

          await markWebhookProcessed(reservation.deliveryId);
          return { success: true };
        }

        if (!["CANCELLED", "EXPIRED"].includes(sub.status)) {
          await markWebhookProcessed(reservation.deliveryId);
          return { success: true };
        }

        if (!existing) {
          await markWebhookProcessed(reservation.deliveryId);
          return { success: true };
        }

        if (existing.pendingSubscriptionId === incomingSubId) {
          await db.subscription.updateMany({
            where: { shop },
            data: {
              pendingSubscriptionId: null,
              pendingPlanKey: null,
              pendingPlanName: null,
            },
          });

          await markWebhookProcessed(reservation.deliveryId);
          return { success: true };
        }

        if (
          existing.subscriptionId &&
          existing.subscriptionId !== incomingSubId &&
          existing.status === "ACTIVE"
        ) {
          await markWebhookProcessed(reservation.deliveryId);
          return { success: true };
        }

        await db.subscription.updateMany({
          where: {
            shop,
            subscriptionId: incomingSubId,
            pendingSubscriptionId: null,
          },
          data: {
            status: "FREE",
            planKey: "FREE",
            planName: "Free Plan",
            subscriptionId: null,
            currentPeriodEnd: null,
            trialEndsAt: null,
            pendingSubscriptionId: null,
            pendingPlanKey: null,
            pendingPlanName: null,
          },
        });

        await markWebhookProcessed(reservation.deliveryId);
        return { success: true };
      } catch (error) {
        await markWebhookFailed(reservation.deliveryId, error);
        logger.error("APP_SUBSCRIPTIONS_UPDATE webhook failed", {
          shop,
          message: error.message,
        });
        throw error;
      }
    },
  },
};
