import { createShopifyBulkOperationStatusReader } from "../services/sync/shopifyBulkOperationStatusReader.js";

export function attachSyncStatusDependencies(req, res, next) {
  const session = res.locals.shopify.session;

  res.locals.syncStatusDependencies = {
    bulkOperationStatusReader: createShopifyBulkOperationStatusReader(session),
  };

  return next();
}

