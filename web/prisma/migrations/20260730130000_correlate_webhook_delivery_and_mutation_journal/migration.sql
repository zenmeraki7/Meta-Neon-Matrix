-- Create shop-scoped unique index on WebhookDelivery
CREATE UNIQUE INDEX IF NOT EXISTS "WebhookDelivery_shop_id_uq"
ON "WebhookDelivery" ("shop", "id");

-- Add webhookDeliveryId column and index to MirrorMutationJournal
ALTER TABLE "MirrorMutationJournal" ADD COLUMN IF NOT EXISTS "webhookDeliveryId" TEXT;

CREATE INDEX IF NOT EXISTS "MirrorMutationJournal_shop_webhookDeliveryId_idx"
ON "MirrorMutationJournal" ("shop", "webhookDeliveryId");

-- Add foreign key constraint
ALTER TABLE "MirrorMutationJournal"
ADD CONSTRAINT "MirrorMutationJournal_webhookDelivery_fkey"
FOREIGN KEY ("shop", "webhookDeliveryId")
REFERENCES "WebhookDelivery" ("shop", "id")
ON DELETE SET NULL;
