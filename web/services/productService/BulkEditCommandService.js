import { BulkEditCommandService as BulkEditCommandServiceV2 } from "../bulkEdit/BulkEditCommandService.js";

export class BulkEditCommandService extends BulkEditCommandServiceV2 {
  constructor(options = {}) {
    const session = options?.session || options;
    super(session);
  }

  async bulkEditProducts(req) {
    return this.createManualBulkEditOperation(req);
  }
}
