-- Phase F: Product/Variant batch-safe index pack

-- Product indexes
CREATE INDEX IF NOT EXISTS "Product_shop_mirrorBatchId_status_idx"
ON "Product"("shop", "mirrorBatchId", "status");

CREATE INDEX IF NOT EXISTS "Product_shop_mirrorBatchId_title_id_idx"
ON "Product"("shop", "mirrorBatchId", "title", "id");

CREATE INDEX IF NOT EXISTS "Product_shop_mirrorBatchId_handle_id_idx"
ON "Product"("shop", "mirrorBatchId", "handle", "id");

CREATE INDEX IF NOT EXISTS "Product_shop_mirrorBatchId_createdAt_id_idx"
ON "Product"("shop", "mirrorBatchId", "createdAt", "id");

CREATE INDEX IF NOT EXISTS "Product_shop_mirrorBatchId_updatedAt_id_idx"
ON "Product"("shop", "mirrorBatchId", "updatedAt", "id");

CREATE INDEX IF NOT EXISTS "Product_shop_mirrorBatchId_publishedAt_id_idx"
ON "Product"("shop", "mirrorBatchId", "publishedAt", "id");

CREATE INDEX IF NOT EXISTS "Product_shop_mirrorBatchId_visibleOnlineStore_idx"
ON "Product"("shop", "mirrorBatchId", "visibleOnlineStore");

CREATE INDEX IF NOT EXISTS "Product_shop_mirrorBatchId_variantCount_idx"
ON "Product"("shop", "mirrorBatchId", "variantCount");

CREATE INDEX IF NOT EXISTS "Product_shop_mirrorBatchId_templateSuffix_idx"
ON "Product"("shop", "mirrorBatchId", "templateSuffix");

-- Variant indexes
CREATE INDEX IF NOT EXISTS "Variant_shop_mirrorBatchId_sku_idx"
ON "Variant"("shop", "mirrorBatchId", "sku");

CREATE INDEX IF NOT EXISTS "Variant_shop_mirrorBatchId_barcode_idx"
ON "Variant"("shop", "mirrorBatchId", "barcode");

CREATE INDEX IF NOT EXISTS "Variant_shop_mirrorBatchId_productId_idx"
ON "Variant"("shop", "mirrorBatchId", "productId");

CREATE INDEX IF NOT EXISTS "Variant_shop_mirrorBatchId_price_idx"
ON "Variant"("shop", "mirrorBatchId", "price");

CREATE INDEX IF NOT EXISTS "Variant_shop_mirrorBatchId_compareAtPrice_idx"
ON "Variant"("shop", "mirrorBatchId", "compareAtPrice");

CREATE INDEX IF NOT EXISTS "Variant_shop_mirrorBatchId_inventoryQuantity_idx"
ON "Variant"("shop", "mirrorBatchId", "inventoryQuantity");

CREATE INDEX IF NOT EXISTS "Variant_shop_mirrorBatchId_taxable_idx"
ON "Variant"("shop", "mirrorBatchId", "taxable");

CREATE INDEX IF NOT EXISTS "Variant_shop_mirrorBatchId_tracked_idx"
ON "Variant"("shop", "mirrorBatchId", "tracked");

CREATE INDEX IF NOT EXISTS "Variant_shop_mirrorBatchId_physicalProduct_idx"
ON "Variant"("shop", "mirrorBatchId", "physicalProduct");

CREATE INDEX IF NOT EXISTS "Variant_shop_mirrorBatchId_position_idx"
ON "Variant"("shop", "mirrorBatchId", "position");

CREATE INDEX IF NOT EXISTS "Variant_shop_mirrorBatchId_productId_position_idx"
ON "Variant"("shop", "mirrorBatchId", "productId", "position");
