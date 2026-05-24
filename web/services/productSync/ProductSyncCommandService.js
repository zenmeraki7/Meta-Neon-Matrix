import crypto from "crypto";
import { prisma } from "../../config/database.js";
import { addProductSyncClearProductTypesJob } from "../../Jobs/Queues/productSyncClearProductTypesJob.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import { assertFeatureEntitlement } from "../entitlement/featureEntitlementService.js";

export class ProductSyncCommandService {
  async createClearProductTypesCommand({ shop }) {
    if (!shop) {
      throw new Error("SHOP_REQUIRED");
    }

    await assertFeatureEntitlement({
      shop,
      feature: "PRODUCT_SYNC",
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

    return {
      operationId,
      status: "QUEUED",
    };
  }
}

export default ProductSyncCommandService;
