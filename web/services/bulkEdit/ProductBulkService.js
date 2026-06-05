import { BulkEditCommandService } from "./BulkEditCommandService.js";
import { BulkEditPreviewService } from "./BulkEditPreviewService.js";
import { BulkEditTargetFreezeService } from "./BulkEditTargetFreezeService.js";
import { ScheduledEditService } from "./ScheduledEditService.js";
import { BulkEditRetryService } from "./BulkEditRetryService.js";

export default class ProductBulkService {
  constructor(session) {
    this.commandService = new BulkEditCommandService(session);
    this.previewService = new BulkEditPreviewService({ session });
    this.targetFreezeService = new BulkEditTargetFreezeService(session);
    this.retryService = new BulkEditRetryService({ shop: session?.shop });
    this.scheduledEditService = new ScheduledEditService({
      session,
      freezeEditHistoryTargets: (historyId, options = {}) =>
        this.targetFreezeService.freezeEditHistoryTargets(historyId, options),
    });
  }

  async bulkEditProducts(input) {
    return this.commandService.createManualBulkEditOperation(input);
  }

  async trackEditProducts(args) {
    return this.previewService.previewBulkEdit(args);
  }

  async getPreviewVariantDetails(args) {
    return this.previewService.getPreviewVariantDetails(args);
  }

  async freezeEditHistoryTargets(historyId, options = {}) {
    return this.targetFreezeService.freezeEditHistoryTargets(historyId, options);
  }

  async retryFailedOnly({ historyId }) {
    return this.retryService.retryFailedOnly({ historyId });
  }

  async createScheduledEdit(args) {
    return this.scheduledEditService.createScheduledEdit(args);
  }
}
