import {
  ProductBulkPreviewService as ProductBulkPreviewServiceImpl,
} from "../productService/ProductBulkPreviewService.js";

export class BulkEditPreviewService extends ProductBulkPreviewServiceImpl {
  constructor(sessionOrOptions) {
    const session = sessionOrOptions?.session || sessionOrOptions;

    if (!session?.shop) {
      throw new Error(
        "BulkEditPreviewService requires an authenticated Shopify session",
      );
    }

    super({ session });
  }

  async previewBulkEdit(args = {}) {
    const {
      shop: _untrustedShop,
      mirrorBatchId: _untrustedMirrorBatchId,
      ...trustedArgs
    } = args;

    return this.trackEditProducts(trustedArgs);
  }
}
