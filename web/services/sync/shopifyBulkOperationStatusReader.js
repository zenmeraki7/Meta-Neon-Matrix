import { getBulkEditStatus } from "../../utils/bulkOperationHelper.js";

export function createShopifyBulkOperationStatusReader(session) {
  return async function readBulkOperationStatus(bulkOperationId) {
    return getBulkEditStatus(bulkOperationId, session);
  };
}

