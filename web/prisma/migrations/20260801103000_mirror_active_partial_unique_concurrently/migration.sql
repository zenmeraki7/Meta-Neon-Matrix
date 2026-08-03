CREATE UNIQUE INDEX "MirrorBatch_one_active_per_shop_resource_uq"
ON "MirrorBatch" ("shop", "resourceType")
WHERE "status" = 'ACTIVE';
