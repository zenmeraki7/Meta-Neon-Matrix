import crypto from "crypto";
import { getProductSyncCacheKeys } from "../../utils/cacheKeyRegistry.js";
import {
  buildIdempotencyRequestHash,
  IdempotencyStoreService,
} from "../idempotency/IdempotencyStoreService.js";

const PRODUCT_SYNC_CLEAR_TYPES_SCOPE = "PRODUCT_SYNC_CLEAR_TYPES";
const DEFAULT_SOURCE = "product_sync";

async function defaultClearCacheKey(key) {
  const { clearKeyCaches } = await import("../../utils/cacheUtils.js");
  return clearKeyCaches(key);
}

async function defaultEnqueueClearProductTypesJob(data) {
  const { addProductSyncClearProductTypesJob } = await import(
    "../../Jobs/Queues/productSyncClearProductTypesJob.js"
  );
  return addProductSyncClearProductTypesJob(data);
}

async function defaultLoadSubscription(shop) {
  const { loadAuthoritativeSubscriptionForShop } = await import(
    "../subscriptionAuthorityService.js"
  );
  return loadAuthoritativeSubscriptionForShop(shop);
}

async function defaultAssertEntitlement(command) {
  const { assertFeatureEntitlement } = await import(
    "../entitlement/featureEntitlementService.js"
  );
  return assertFeatureEntitlement(command);
}

function buildServiceError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

export class ProductSyncCommandService {
  constructor({
    db = null,
    idempotencyStore = null,
    enqueueClearProductTypesJob = defaultEnqueueClearProductTypesJob,
    loadSubscription = defaultLoadSubscription,
    assertEntitlement = defaultAssertEntitlement,
    clearCacheKey = defaultClearCacheKey,
    getSyncCacheKeys = getProductSyncCacheKeys,
  } = {}) {
    this.db = db;
    this.idempotencyStore = idempotencyStore;
    this.enqueueClearProductTypesJob = enqueueClearProductTypesJob;
    this.loadSubscription = loadSubscription;
    this.assertEntitlement = assertEntitlement;
    this.clearCacheKey = clearCacheKey;
    this.getSyncCacheKeys = getSyncCacheKeys;
  }

  async createClearProductTypesCommand({
    shop,
    idempotencyKey,
    subscription,
    source = DEFAULT_SOURCE,
  }) {
    const scopedShop = String(shop || "").trim();
    if (!scopedShop) {
      throw new Error("SHOP_REQUIRED");
    }
    const idemKey = String(idempotencyKey || "").trim();
    if (!idemKey) {
      const error = new Error("IDEMPOTENCY_KEY_REQUIRED");
      error.code = "IDEMPOTENCY_KEY_REQUIRED";
      throw error;
    }
    const normalizedSource = String(source || DEFAULT_SOURCE).trim() || DEFAULT_SOURCE;
    const authoritativeSubscription = await this.loadSubscription(scopedShop);

    if (subscription?.shop && String(subscription.shop).trim() !== scopedShop) {
      const error = new Error("SUBSCRIPTION_SHOP_MISMATCH");
      error.code = "FORBIDDEN";
      throw error;
    }

    await this.assertEntitlement({
      shop: scopedShop,
      feature: "PRODUCT_SYNC",
      subscription: authoritativeSubscription,
    });
    const db = await this.#resolveDb();
    const idempotencyStore = await this.#resolveIdempotencyStore(db);

    const requestHash = buildIdempotencyRequestHash({
      shop: scopedShop,
      scope: PRODUCT_SYNC_CLEAR_TYPES_SCOPE,
      idempotencyKey: idemKey,
      source: normalizedSource,
      entitlementSubscriptionId: authoritativeSubscription?.subscriptionId || null,
      entitlementPlanKey: authoritativeSubscription?.planKey || null,
      entitlementStatus: authoritativeSubscription?.status || null,
    });
    const begin = await idempotencyStore.begin({
      shop: scopedShop,
      scope: PRODUCT_SYNC_CLEAR_TYPES_SCOPE,
      key: idemKey,
      requestHash,
    });
    if (begin.mode === "replay") {
      return begin.response;
    }

    const operationId = crypto.randomUUID();
    const executionId = crypto.randomUUID();
    let syncHistoryCreated = false;

    try {
      await db.syncHistory.create({
        data: {
          id: operationId,
          shop: scopedShop,
          status: "processing",
          duration: 0,
          recordCount: 0,
          operationType: "ProductType",
          executionState: "queued",
          executionIdentity: executionId,
        },
      });
      syncHistoryCreated = true;

      await this.enqueueClearProductTypesJob({
        shop: scopedShop,
        operationId,
        executionId,
        source: normalizedSource,
      });

      await Promise.all(this.getSyncCacheKeys(scopedShop).map((key) => this.clearCacheKey(key)));

      const response = {
        operationId,
        executionId,
        status: "QUEUED",
      };
      await idempotencyStore.complete({
        recordId: begin.recordId,
        shop: scopedShop,
        response,
      });
      return response;
    } catch (error) {
      if (syncHistoryCreated) {
        await db.syncHistory.updateMany({
          where: { id: operationId, shop: scopedShop },
          data: {
            status: "failed",
            executionState: "failed",
            errorMessage: String(error?.message || error || "PRODUCT_SYNC_QUEUE_FAILED").slice(0, 2000),
          },
        }).catch(() => {});
      }
      if (begin?.recordId) {
        await db.idempotencyRecord.deleteMany({
          where: { id: begin.recordId, shop: scopedShop },
        }).catch(() => {});
      }
      throw buildServiceError("PRODUCT_SYNC_CLEAR_TYPES_COMMAND_FAILED", error);
    }
  }

  async #resolveDb() {
    if (this.db) return this.db;
    const { db } = await import("../../repositories/repositoryDb.js");
    this.db = db;
    return db;
  }

  async #resolveIdempotencyStore(db) {
    if (this.idempotencyStore) return this.idempotencyStore;
    this.idempotencyStore = new IdempotencyStoreService(db);
    return this.idempotencyStore;
  }
}

export default ProductSyncCommandService;
