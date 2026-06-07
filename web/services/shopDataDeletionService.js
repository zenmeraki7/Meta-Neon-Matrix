import crypto from "node:crypto";
import logger from "../utils/loggerUtils.js";
import {
  TENANT_MODELS_REQUIRING_DELETION,
  assertRetentionPolicyComplete,
} from "./dataRetentionPolicy.js";

const step = (model, field = "shop") => Object.freeze({
  model,
  client: model.charAt(0).toLowerCase() + model.slice(1),
  field,
});

// Child rows precede parents. Keep this explicit so FK changes are reviewed.
export const SHOP_DATA_DELETION_STEPS = Object.freeze([
  step("VariantMetafield", "shopId"),
  step("DeadLetterChange", "shopId"),
  step("BulkEditChange", "shopId"),
  step("SyncCursor", "shopId"),
  step("BulkEditSession", "shopId"),
  step("UndoOperationConflictChunk"),
  step("UndoOperation"),
  step("BulkEditRecoveryAudit"),
  step("EditHistoryIngestionCheckpoint"),
  step("ChangeRecord"),
  step("BulkSubmission"),
  step("OperationStageProgress"),
  step("TargetSnapshotItem"),
  step("EditHistory"),
  step("TargetSnapshotSet"),
  step("TargetSnapshot"),
  step("AutomaticRuleApplication"),
  step("AutomaticProductRuleProductState"),
  step("AutomaticProductRuleRun"),
  step("TargetFreezeCommand"),
  step("AutomaticProductRule"),
  step("RecurringEditRun"),
  step("RecurringEdit"),
  step("ScheduledExportRun"),
  step("ExportJob"),
  step("ExportHistory"),
  step("ScheduledExport"),
  step("SpreadsheetFile"),
  step("OperationEnqueueIntent"),
  step("OutboxEvent"),
  step("OperationFingerprint"),
  step("OperationLease"),
  step("IdempotencyRecord"),
  step("FilterTrack"),
  step("WebhookDelivery"),
  step("MirrorReconcileSignal"),
  step("MirrorAnomaly"),
  step("ErrorLog"),
  step("DeadLetterJob"),
  step("BillingEvent"),
  step("ProductTombstone"),
  step("MetafieldMirror"),
  step("InventoryLevelMirror"),
  step("InventoryItemMirror"),
  step("ProductMediaMirror"),
  step("ProductCollection"),
  step("Variant"),
  step("Product"),
  step("Location"),
  step("Collection"),
  step("MirrorBatch"),
  step("SyncHistory"),
  step("ProductCodeSnippet"),
  step("ReferralCode"),
  step("Subscription"),
  step("ShopifySession"),
  step("Store", "shopUrl"),
  step("Shop", "shopifyDomain"),
]);

export function assertShopDeletionRegistryComplete() {
  assertRetentionPolicyComplete();
  const required = new Set(TENANT_MODELS_REQUIRING_DELETION);
  const declared = new Set(SHOP_DATA_DELETION_STEPS.map(({ model }) => model));
  const missing = [...required].filter((model) => !declared.has(model));
  const unknown = [...declared].filter((model) => !required.has(model));
  if (missing.length || unknown.length) {
    throw new Error(
      `SHOP_DELETION_REGISTRY_INCOMPLETE:missing=${missing.join(",")}:unknown=${unknown.join(",")}`,
    );
  }
  return true;
}

function hashShop(shop) {
  return crypto.createHash("sha256").update(shop).digest("hex");
}

export async function writeExternalDeletionAudit({
  shop,
  deletionLog,
  auditLogger = logger,
  now = () => new Date(),
}) {
  auditLogger.info("SHOP_DATA_DELETED_AUDIT", {
    shopHash: hashShop(shop),
    deletedAt: now().toISOString(),
    rowCounts: deletionLog,
  });
}

export async function deleteAllShopData(
  shop,
  {
    db = null,
    serviceLogger = logger,
    auditWriter = writeExternalDeletionAudit,
  } = {},
) {
  const scopedShop = String(shop || "").trim();
  if (!scopedShop) throw new Error("deleteAllShopData requires shop");
  assertShopDeletionRegistryComplete();
  const database = db || (await import("../repositories/repositoryDb.js")).db;

  serviceLogger.info("SHOP_DATA_DELETION_STARTED", { shop: scopedShop });
  const deletionLog = {};
  const legacyShop = await database.shop.findFirst({
    where: { shopifyDomain: scopedShop },
    select: { id: true },
  });

  for (const { model, client, field } of SHOP_DATA_DELETION_STEPS) {
    const delegate = database[client];
    if (!delegate?.deleteMany) {
      throw new Error(`SHOP_DATA_DELETION_DELEGATE_MISSING:${model}`);
    }
    // Sequential and idempotent: a retry resumes safely after the last completed model.
    // eslint-disable-next-line no-await-in-loop
    const result = await delegate.deleteMany({
      where: {
        [field]: field === "shopId"
          ? (legacyShop?.id || scopedShop)
          : scopedShop,
      },
    });
    deletionLog[model] = Number(result?.count || 0);
  }

  serviceLogger.info("SHOP_DATA_DELETION_COMPLETE", {
    shop: scopedShop,
    rowCounts: deletionLog,
  });
  await auditWriter({ shop: scopedShop, deletionLog });
  return deletionLog;
}

assertShopDeletionRegistryComplete();
