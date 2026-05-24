import shopify from "../../shopify.js";
import { BulkEditCommandService } from "../bulkEdit/BulkEditCommandService.js";
import { BulkEditPreviewService } from "../bulkEdit/BulkEditPreviewService.js";
import { BulkEditTargetFreezeService } from "../bulkEdit/BulkEditTargetFreezeService.js";
import { BulkEditExecutionPreparationService } from "../bulkEdit/BulkEditExecutionPreparationService.js";
import { ShopifyBulkMutationService } from "../bulkEdit/ShopifyBulkMutationService.js";
import { BulkEditRetryService } from "../bulkEdit/BulkEditRetryService.js";
import { ScheduledEditService } from "../bulkEdit/ScheduledEditService.js";

export default class ProductBulkService {
  constructor(session) {
    this.session = session;
    this.client = new shopify.api.clients.Graphql({ session });

    this.commandService = new BulkEditCommandService(session);
    this.previewService = new BulkEditPreviewService(session);
    this.targetFreezeService = new BulkEditTargetFreezeService(session);
    this.executionPreparationService = new BulkEditExecutionPreparationService(session);
    this.shopifyBulkMutationService = new ShopifyBulkMutationService(session, this.client);
    this.retryService = new BulkEditRetryService(session);
    this.scheduledEditService = new ScheduledEditService(session);
  }

  async bulkEditProducts(req) {
    return this.commandService.createManualBulkEditOperation(req);
  }

  async _bulkOperationEdit(body, subscription, operationContext = {}) {
    return this.commandService.createEditHistoryPayload(body, subscription, operationContext);
  }

  async trackEditProducts(args) {
    return this.previewService.previewBulkEdit(args);
  }

  async freezeEditHistoryTargets(historyId, options = {}) {
    return this.targetFreezeService.freezeEditHistoryTargets(historyId, options);
  }

  async _preparingBulkOperation({ historyId }) {
    return this.executionPreparationService.prepareNextExecutionBatch({ historyId });
  }

  async _bulkOperationHelper({
    historyId = null,
    executionId = null,
    formattedProducts,
    field,
    fields = [],
    batchId = null,
    batchTargetCount = 0,
    lastProductId = null,
    hasMore = false,
    nextRetryCursorIndex = null,
  }) {
    return this.shopifyBulkMutationService.submitProductSetBulkMutation({
      historyId,
      executionId,
      formattedProducts,
      fields,
      batchId,
      batchTargetCount,
      lastProductId,
      hasMore,
      nextRetryCursorIndex,
    });
  }

  async retryFailedOnly({ historyId }) {
    return this.retryService.retryFailedOnly({ historyId });
  }

  async createScheduledEdit(args) {
    return this.scheduledEditService.createScheduledEdit(args);
  }
}
