CREATE INDEX IF NOT EXISTS "TargetSnapshot_shop_owner_owner_batch_type_ordinal_id_idx"
ON "TargetSnapshot"("shop", "ownerType", "ownerId", "mirrorBatchId", "targetType", "ordinal", "id");

CREATE INDEX IF NOT EXISTS "TargetSnapshot_shop_owner_batch_filterhash_type_ordinal_idx"
ON "TargetSnapshot"("shop", "ownerType", "ownerId", "mirrorBatchId", "filterHash", "targetType", "ordinal");
