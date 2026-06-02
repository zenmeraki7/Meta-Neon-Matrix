-- Phase J: option-value semantic hardening indexes
CREATE INDEX IF NOT EXISTS "Variant_shop_mirrorBatchId_productId_option1Value_idx"
ON "Variant"("shop", "mirrorBatchId", "productId", "option1Value");

CREATE INDEX IF NOT EXISTS "Variant_shop_mirrorBatchId_productId_option2Value_idx"
ON "Variant"("shop", "mirrorBatchId", "productId", "option2Value");

CREATE INDEX IF NOT EXISTS "Variant_shop_mirrorBatchId_productId_option3Value_idx"
ON "Variant"("shop", "mirrorBatchId", "productId", "option3Value");
