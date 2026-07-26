import crypto from "crypto";
import { db as repositoryDb } from "../../repositories/repositoryDb.js";
import { addProductSyncClearProductTypesJob } from "../../Jobs/Queues/productSyncClearProductTypesJob.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import { assertFeatureEntitlement } from "../entitlement/featureEntitlementService.js";
import { normalizeShopDomain } from "../../utils/shopDomainUtils.js";

function buildPayloadHash(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function buildCodedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export class ProductSyncCommandService {
  constructor(db = repositoryDb) {
    this.db = db;
  }

  async createClearProductTypesCommand({ shop, actor, idempotencyKey, subscription }) {
    const canonicalShop = normalizeShopDomain(shop);
    if (!canonicalShop) {
      throw buildCodedError("SHOP_REQUIRED", "Canonical shop is required");
    }

    const key = String(idempotencyKey || "").trim();
    if (!key) {
      throw buildCodedError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency key is required");
    }

    await assertFeatureEntitlement({
      shop: canonicalShop,
      feature: "PRODUCT_SYNC",
      subscription,
    });

    const commandType = "CLEAR_PRODUCT_TYPES";
    const payload = { shop: canonicalShop, type: commandType };
    const payloadHash = buildPayloadHash(payload);

    // Durable Transaction: Create ProductSyncCommand, OperationFingerprint, SyncHistory, and OperationEnqueueIntent in 1 tx
    const transactionResult = await this.db.$transaction(async (tx) => {
      // Check existing ProductSyncCommand with @@unique([shop, type, idempotencyKey])
      const existingCommand = await tx.productSyncCommand.findUnique({
        where: {
          shop_type_idempotencyKey: {
            shop: canonicalShop,
            type: commandType,
            idempotencyKey: key,
          },
        },
      });

      if (existingCommand) {
        if (existingCommand.payloadHash !== payloadHash) {
          throw buildCodedError(
            "IDEMPOTENCY_KEY_CONFLICT",
            "Idempotency key reused with a different payload",
          );
        }
        return {
          mode: "replay",
          command: existingCommand,
        };
      }

      const commandId = crypto.randomUUID();
      const executionId = crypto.randomUUID();

      const createdCommand = await tx.productSyncCommand.create({
        data: {
          id: commandId,
          shop: canonicalShop,
          type: commandType,
          status: "QUEUED",
          idempotencyKey: key,
          payloadHash,
          actorJson: actor || {},
        },
      });

      await tx.syncHistory.create({
        data: {
          id: commandId,
          shop: canonicalShop,
          status: "processing",
          duration: 0,
          recordCount: 0,
          operationType: "ProductType",
          executionState: "queued",
          executionIdentity: executionId,
        },
      });

      await tx.operationEnqueueIntent.create({
        data: {
          shop: canonicalShop,
          queueRoutingKey: "product_sync_clear_types",
          queueJobName: "addProductSyncClearProductTypesJob",
          payload: {
            shop: canonicalShop,
            operationId: commandId,
            executionId,
            source: "product_sync_controller",
          },
          status: "PENDING",
        },
      });

      return {
        mode: "created",
        command: createdCommand,
        executionId,
      };
    });

    // Post-commit side effects: Queue dispatch after transaction commits
    if (transactionResult.mode === "created") {
      await addProductSyncClearProductTypesJob({
        shop: canonicalShop,
        operationId: transactionResult.command.id,
        executionId: transactionResult.executionId,
        source: "product_sync_controller",
      });
      await clearKeyCaches(`${canonicalShop}:sync_details`);
    }

    return {
      operationId: transactionResult.command.id,
      status: transactionResult.command.status,
    };
  }
}

export default ProductSyncCommandService;
