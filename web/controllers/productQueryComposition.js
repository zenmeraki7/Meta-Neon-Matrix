import {
  executeProductQuery,
  getPreviewFilterRegistry,
  getProductFilterValueOptions,
  getProductTypeOptions,
} from "../services/productService/productQueryCommandService.js";
import { getBulkEditStatus } from "../services/productService/bulkEditStatusService.js";
import { createProductQueryController } from "./productQueryController.js";

export const defaultProductQueryController = createProductQueryController({
  executeProductQuery,
  getBulkEditStatus,
  getPreviewFilterRegistry,
  getProductFilterValueOptions,
  getProductTypeOptions,
});

export const {
  getProductsWithQuery,
  checkEditStatus,
  getProductTypes,
  getProductFilterValues,
  getFilterRegistry,
} = defaultProductQueryController;
