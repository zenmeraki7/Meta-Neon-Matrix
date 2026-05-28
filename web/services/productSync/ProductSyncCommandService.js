import crypto from "crypto";
import { prisma } from "../../config/database.js";
import { addProductSyncClearProductTypesJob } from "../../Jobs/Queues/productSyncClearProductTypesJob.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import { assertFeatureEntitlement } from "../entitlement/featureEntitlementService.js";
import {
  buildIdempotencyRequestHash,
  IdempotencyStoreService,
} from "../idempotency/IdempotencyStoreService.js";

export class ProductSyncCommandService {
  constructor() {
    this.idempotencyStore = new IdempotencyStoreService(prisma);
  }

  async createClearProductTypesCommand({ shop, idempotencyKey, subscription }) {
    if (!shop) {
      throw new Error("SHOP_REQUIRED");
    }
    const idemKey = String(idempotencyKey || "").trim();
    if (!idemKey) {
      const error = new Error("IDEMPOTENCY_KEY_REQUIRED");
      error.code = "IDEMPOTENCY_KEY_REQUIRED";
      throw error;
    }

    const begin = await this.idempotencyStore.begin({
      shop,
      scope: "PRODUCT_SYNC_CLEAR_TYPES",
      key: idemKey,
      requestHash: buildIdempotencyRequestHash({
        shop,
        operationType: "PRODUCT_SYNC_CLEAR_TYPES",
      }),
    });
    if (begin.mode === "replay") {
      return begin.response;
    }

    await assertFeatureEntitlement({
      shop,
      feature: "PRODUCT_SYNC",
      subscription,
    });

    const operationId = crypto.randomUUID();
    const executionId = crypto.randomUUID();

    await prisma.syncHistory.create({
      data: {
        id: operationId,
        shop,
        status: "processing",
        duration: 0,
        recordCount: 0,
        operationType: "ProductType",
        executionState: "queued",
        executionIdentity: executionId,
      },
    });

    await addProductSyncClearProductTypesJob({
      shop,
      operationId,
      executionId,
      source: "product_sync_controller",
    });

    await clearKeyCaches(`${shop}:sync_details`);

    const response = {
      operationId,
      status: "QUEUED",
    };
    await this.idempotencyStore.complete({
      recordId: begin.recordId,
      response,
    });
    return response;
  }
}

export default ProductSyncCommandService;
