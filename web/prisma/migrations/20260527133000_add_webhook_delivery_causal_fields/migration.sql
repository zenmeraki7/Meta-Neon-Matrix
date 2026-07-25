ALTER TABLE "WebhookDelivery"
ADD COLUMN "firstWebhookId" TEXT,
ADD COLUMN "lastWebhookId" TEXT,
ADD COLUMN "causalChainId" TEXT;

CREATE INDEX "WebhookDelivery_shop_entityId_createdAt_idx"
ON "WebhookDelivery"("shop", "entityId", "createdAt");
