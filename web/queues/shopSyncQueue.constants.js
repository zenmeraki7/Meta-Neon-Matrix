export const SHOP_SYNC_QUEUE_NAME =
  process.env.SHOP_SYNC_QUEUE || "shop-sync-trigger";

export const SHOP_SYNC_DLQ_QUEUE_NAME =
  process.env.SHOP_SYNC_DLQ_QUEUE || "shop-sync-dlq";
