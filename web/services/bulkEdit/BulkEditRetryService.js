import { BulkEditRetryService as BulkEditRetryServiceImpl } from "../productService/BulkEditRetryService.js";

export class BulkEditRetryService extends BulkEditRetryServiceImpl {
  constructor(sessionOrOptions) {
    if (sessionOrOptions?.shop) {
      super({ shop: sessionOrOptions.shop });
      return;
    }

    const session = sessionOrOptions?.session || sessionOrOptions;
    super({ shop: session?.shop });
  }
}
