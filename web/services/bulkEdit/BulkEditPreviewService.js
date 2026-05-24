import { ProductBulkPreviewService as ProductBulkPreviewServiceImpl } from "../productService/ProductBulkPreviewService.js";

export class BulkEditPreviewService extends ProductBulkPreviewServiceImpl {
  constructor(sessionOrOptions) {
    const session = sessionOrOptions?.session || sessionOrOptions;
    super({ session });
  }

  async previewBulkEdit(args) {
    return this.trackEditProducts(args);
  }
}
