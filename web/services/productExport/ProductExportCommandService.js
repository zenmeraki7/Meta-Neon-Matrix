import { ProductExportService } from "../productService/productExportService.js";

export class ProductExportCommandService {
  constructor(session) {
    this.service = new ProductExportService(session);
  }

  async createExportCommand({
    fields,
    fileName,
    filterParams,
    filterAst = null,
    options = null,
    actor = null,
    entitlementSnapshot = null,
    idempotencyKey = null,
  }) {
    return this.service.createExportJob({
      fields,
      fileName,
      filterParams,
      filterAst,
      options,
      actor,
      entitlementSnapshot,
      idempotencyKey,
    });
  }

  async getExportDetails(input) {
    const exportJobId =
      typeof input === "string" ? input : input?.exportJobId || input?.id;
    return this.service.getExportHistoryDetails(exportJobId);
  }
}

export default ProductExportCommandService;
