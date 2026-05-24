import { BulkEditTargetFreezeService } from "./BulkEditTargetFreezeService.js";
import { ScheduledEditService as ScheduledEditServiceImpl } from "../productService/ScheduledEditService.js";

export class ScheduledEditService extends ScheduledEditServiceImpl {
  constructor(sessionOrOptions) {
    if (sessionOrOptions?.session && sessionOrOptions?.freezeEditHistoryTargets) {
      super(sessionOrOptions);
      return;
    }

    const session = sessionOrOptions?.session || sessionOrOptions;
    const targetFreezeService = new BulkEditTargetFreezeService(session);
    super({
      session,
      freezeEditHistoryTargets: (historyId, options = {}) =>
        targetFreezeService.freezeEditHistoryTargets(historyId, options),
    });
  }
}
