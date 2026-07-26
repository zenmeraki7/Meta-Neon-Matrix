import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");

test("reconciliation and webhook dedupe identities are tenant scoped", () => {
  const schema = read("web/prisma/schema.prisma");
  const privacy = read("web/privacy.js");

  assert.match(
    schema,
    /model MirrorReconcileSignal[\s\S]*?@@id\(\[shop, entityType, entityId\]\)/,
  );
  assert.match(schema, /@@unique\(\[shop, dedupeKey\]\)/);
  assert.match(schema, /shopifyWebhookId\s+String\?\s+@map\("webhookId"\)/);
  assert.match(privacy, /shop_dedupeKey: \{ shop, dedupeKey \}/);
  assert.doesNotMatch(privacy, /create:\s*\{\s*id:\s*signalId/);
});

test("Shopify session adapter has shop indexes and one expiry representation", () => {
  const schema = read("web/prisma/schema.prisma");
  const sessionModel = schema.match(/model ShopifySession \{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(sessionModel, /@@index\(\[shop\]\)/);
  assert.match(sessionModel, /@@index\(\[shop, isOnline\]\)/);
  assert.match(sessionModel, /@@index\(\[shop, expires\]\)/);
  assert.doesNotMatch(sessionModel, /expiresAt/);
});

test("Store exposes corrected names and encrypted-only token storage", () => {
  const schema = read("web/prisma/schema.prisma");
  const crypto = read("web/utils/tokenCrypto.js");

  assert.match(schema, /shopEmail\s+String\?/);
  assert.match(schema, /isProductInitiallySyncing[\s\S]*@map\("isProductInitialySyning"\)/);
  assert.match(schema, /uninstalledAt[\s\S]*@map\("unInstalledAt"\)/);
  assert.match(schema, /installationStatus\s+StoreInstallationStatus/);
  const storeModel = schema.match(/model Store \{[\s\S]*?\n\}/)?.[0] || "";
  assert.doesNotMatch(storeModel, /\n\s+accessToken\s+String/);
  assert.doesNotMatch(storeModel, /legacyIsUninstalled/);
  assert.match(crypto, /ACCESS_TOKEN_ENCRYPTION_REQUIRED/);
  assert.match(crypto, /accessTokenEncrypted: encrypted/);
});

test("migration swaps natural identity indexes and removes duplicate expiry", () => {
  const migration = read(
    "web/prisma/migrations/20260722104000_harden_webhook_session_and_store_identity/migration.sql",
  );

  assert.match(migration, /PRIMARY KEY USING INDEX "MirrorReconcileSignal_shop_entityType_entityId_key"/);
  assert.match(migration, /CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "WebhookDelivery_shop_dedupeKey_key"/);
  assert.match(migration, /DROP INDEX CONCURRENTLY IF EXISTS "WebhookDelivery_dedupeKey_key"/);
  assert.match(migration, /DROP COLUMN IF EXISTS "expiresAt"/);
  assert.match(migration, /ALTER COLUMN "shopEmail" DROP NOT NULL/);
});
