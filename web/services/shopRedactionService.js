import { db } from "../repositories/repositoryDb.js";
import { requireShopScope } from "../utils/shopScope.js";
import logger from "../utils/loggerUtils.js";
import { clearKeyCaches } from "../utils/cacheUtils.js";

/**
 * Idempotent Shop Redaction Workflow used by APP_UNINSTALLED, SHOP_REDACT, and appUninstallWorker.
 * Fences the shop, invalidates active mirror pointers to avoid ON DELETE RESTRICT rollbacks,
 * and purges store credentials, sessions, subscriptions, and mirror data.
 */
export async function executeShopRedaction({ shop, topic = "SHOP_REDACT", webhookId = null }) {
  const scopedShop = requireShopScope(shop);
  const effectiveWebhookId = webhookId || `redact_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  // 1. Record durable compliance request for idempotency
  try {
    await db.complianceRequest.create({
      data: {
        shop: scopedShop,
        topic,
        webhookId: effectiveWebhookId,
        status: "PROCESSING",
      },
    });
  } catch (error) {
    if (error?.code === "P2002") {
      logger.info("Compliance request already recorded / duplicate ignored", {
        shop: scopedShop,
        topic,
        webhookId: effectiveWebhookId,
      });
      return { success: true, duplicate: true };
    }
    throw error;
  }

  // 2. Perform single transactional cleanup
  try {
    await db.$transaction(async (tx) => {
      // Step A: Fence shop status & clear active mirror batch pointers & erase credentials
      await tx.store.updateMany({
        where: { shopUrl: scopedShop },
        data: {
          installationStatus: "REDACTING",
          currentProductMirrorBatchId: null,
          currentCollectionMirrorBatchId: null,
          shopEmail: null,
          accessTokenEncrypted: null,
          uninstalledAt: new Date(),
          isProductSyncing: false,
          isCollectionSyncing: false,
          isProductTypeSyncing: false,
          isProductInitiallySyncing: false,
        },
      });

      // Fetch history IDs for changeRecord purge
      const editHistoryIds = await tx.editHistory.findMany({
        where: { shop: scopedShop },
        select: { id: true },
      });
      const historyIdList = editHistoryIds.map((h) => h.id);

      if (historyIdList.length > 0) {
        await tx.changeRecord.deleteMany({
          where: {
            editHistoryId: { in: historyIdList },
            shop: scopedShop,
          },
        });
      }

      // Step B: Purge merchant-owned records
      await tx.variant.deleteMany({ where: { shop: scopedShop } });
      await tx.product.deleteMany({ where: { shop: scopedShop } });
      await tx.productCollection.deleteMany({ where: { shop: scopedShop } });
      await tx.metafieldMirror.deleteMany({ where: { shop: scopedShop } });
      await tx.inventoryLevelMirror.deleteMany({ where: { shop: scopedShop } });
      await tx.inventoryItemMirror.deleteMany({ where: { shop: scopedShop } });
      await tx.productMediaMirror.deleteMany({ where: { shop: scopedShop } });
      await tx.location.deleteMany({ where: { shop: scopedShop } });
      await tx.productTombstone.deleteMany({ where: { shop: scopedShop } });
      await tx.collection.deleteMany({ where: { shop: scopedShop } });

      // Safe to delete mirrorBatch now that active pointers were set to NULL above
      await tx.mirrorBatch.deleteMany({ where: { shop: scopedShop } });

      await tx.mirrorAnomaly.deleteMany({ where: { shop: scopedShop } });
      await tx.mirrorReconcileSignal.deleteMany({ where: { shop: scopedShop } });
      await tx.operationLease.deleteMany({ where: { shop: scopedShop } });
      await tx.operationFingerprint.deleteMany({ where: { shop: scopedShop } });
      await tx.errorLog.deleteMany({ where: { shop: scopedShop } });
      await tx.webhookDelivery.deleteMany({ where: { shop: scopedShop } });
      await tx.billingEvent.deleteMany({ where: { shop: scopedShop } });
      await tx.filterTrack.deleteMany({ where: { shop: scopedShop } });
      await tx.syncHistory.deleteMany({ where: { shop: scopedShop } });
      await tx.editHistory.deleteMany({ where: { shop: scopedShop } });
      await tx.exportJob.deleteMany({ where: { shop: scopedShop } });
      await tx.targetSnapshotSet.deleteMany({ where: { shop: scopedShop } });
      await tx.automaticProductRuleProductState.deleteMany({ where: { shop: scopedShop } });
      await tx.automaticProductRuleRun.deleteMany({ where: { shop: scopedShop } });
      await tx.automaticProductRule.deleteMany({ where: { shop: scopedShop } });
      await tx.recurringEditRun.deleteMany({ where: { shop: scopedShop } });
      await tx.recurringEdit.deleteMany({ where: { shop: scopedShop } });
      await tx.scheduledExportRun.deleteMany({ where: { shop: scopedShop } });
      await tx.scheduledExport.deleteMany({ where: { shop: scopedShop } });

      // Step C: Delete sessions, subscription, and store
      await tx.shopifySession.deleteMany({ where: { shop: scopedShop } });
      await tx.subscription.deleteMany({ where: { shop: scopedShop } });
      await tx.store.deleteMany({ where: { shopUrl: scopedShop } });
    });

    // Update compliance request status to COMPLETED
    await db.complianceRequest.update({
      where: {
        shop_topic_webhookId: {
          shop: scopedShop,
          topic,
          webhookId: effectiveWebhookId,
        },
      },
      data: { status: "COMPLETED" },
    }).catch(() => {});

    await clearKeyCaches(scopedShop);

    logger.info("Shop redaction completed successfully", {
      shop: scopedShop,
      topic,
      webhookId: effectiveWebhookId,
    });

    return { success: true };
  } catch (error) {
    await db.complianceRequest.update({
      where: {
        shop_topic_webhookId: {
          shop: scopedShop,
          topic,
          webhookId: effectiveWebhookId,
        },
      },
      data: { status: "FAILED" },
    }).catch(() => {});

    logger.error("Shop redaction failed", {
      shop: scopedShop,
      topic,
      webhookId: effectiveWebhookId,
      error: error.message,
    });
    throw error;
  }
}
