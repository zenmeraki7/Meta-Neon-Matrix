CREATE INDEX IF NOT EXISTS "Product_shop_mirrorBatchId_totalInventory_idx"
ON "Product"("shop", "mirrorBatchId", "totalInventory");
