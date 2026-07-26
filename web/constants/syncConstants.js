// web/constants/syncConstants.js

export const SYNC_OPERATION_TYPE = Object.freeze({
  PRODUCT: "Product",
  COLLECTION: "Collection",
  PRODUCT_TYPE: "ProductType",
});

export const SYNC_STATUS = Object.freeze({
  QUEUED: "queued",
  PROCESSING: "processing",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
});

export const SYNC_STATUS_NORMALIZED = Object.freeze({
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  PROCESSING: "PROCESSING",
});
