export const PRODUCT_CREATE_QUEUE_NAME =
  process.env.PRODUCT_CREATE_QUEUE_NAME || "product-create";
export const PRODUCT_UPDATE_QUEUE_NAME =
  process.env.PRODUCT_UPDATE_QUEUE_NAME || "product-update";
export const PRODUCT_UPDATE_DLQ_QUEUE_NAME =
  process.env.PRODUCT_UPDATE_DLQ_QUEUE_NAME || "product-update-dlq";
export const PRODUCT_DELETE_QUEUE_NAME =
  process.env.PRODUCT_DELETE_QUEUE_NAME || "product-delete";
export const PRODUCT_DELETE_DLQ_QUEUE_NAME =
  process.env.PRODUCT_DELETE_DLQ_QUEUE_NAME || "product-delete-dlq";
