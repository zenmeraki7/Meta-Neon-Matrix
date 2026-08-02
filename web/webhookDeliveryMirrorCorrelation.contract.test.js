import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { applyProductUpsertMutation } from "./repositories/mirrorMutationRepository.js";

function createFakeCorrelationDb() {
  const webhookDeliveries = new Map();
  const mutationJournals = [];
  const products = new Map();
  const tombstones = new Map();
  const reconcileSignals = new Map();

  const fakeTx = {
    webhookDelivery: {
      async updateMany({ where, data }) {
        let count = 0;
        for (const [id, delivery] of webhookDeliveries.entries()) {
          if (where.id && delivery.id !== where.id) continue;
          if (where.shop && delivery.shop !== where.shop) continue;
          if (where.statusNormalized?.in && !where.statusNormalized.in.includes(delivery.statusNormalized)) continue;

          const updated = { ...delivery, ...data };
          webhookDeliveries.set(id, updated);
          count++;
        }
        return { count };
      },
    },
    mirrorMutationJournal: {
      async create({ data }) {
        const sequence = BigInt(mutationJournals.length + 1);
        const record = { sequence, ...data };
        mutationJournals.push(record);
        return { sequence };
      },
    },
    productTombstone: {
      async deleteMany() {
        return { count: 0 };
      },
    },
    product: {
      async upsert({ where, create, update }) {
        const key = `${where.shop_id_mirrorBatchId.shop}:${where.shop_id_mirrorBatchId.id}:${where.shop_id_mirrorBatchId.mirrorBatchId}`;
        const existing = products.get(key);
        const saved = existing ? { ...existing, ...update } : { ...create };
        products.set(key, saved);
        return saved;
      },
    },
    variant: {
      async deleteMany() {
        return { count: 0 };
      },
    },
    mirrorReconcileSignal: {
      async updateMany() {
        return { count: 0 };
      },
    },
    async $executeRaw() {
      return 0;
    },
  };

  return {
    webhookDeliveries,
    mutationJournals,
    products,
    dbClient: {
      async $transaction(cb) {
        return cb(fakeTx);
      },
    },
  };
}

test("schema.prisma defines MirrorMutationJournal.webhookDeliveryId and WebhookDelivery shop-scoped unique index", () => {
  const schema = fs.readFileSync(new URL("./prisma/schema.prisma", import.meta.url), "utf8");
  assert.ok(schema.includes("webhookDeliveryId String?"), "MirrorMutationJournal.webhookDeliveryId missing");
  assert.ok(schema.includes("webhookDelivery WebhookDelivery?"), "MirrorMutationJournal.webhookDelivery relation missing");
  assert.ok(schema.includes("@@unique([shop, id])"), "WebhookDelivery tenant-scoped unique index missing");
});

test("migration file contains WebhookDelivery unique index and MirrorMutationJournal foreign key constraint", () => {
  const migration = fs.readFileSync(
    new URL("./prisma/migrations/20260730130000_correlate_webhook_delivery_and_mutation_journal/migration.sql", import.meta.url),
    "utf8",
  );
  assert.ok(migration.includes('CREATE UNIQUE INDEX IF NOT EXISTS "WebhookDelivery_shop_id_uq"'), "WebhookDelivery shop-scoped index missing");
  assert.ok(migration.includes('ALTER TABLE "MirrorMutationJournal" ADD COLUMN IF NOT EXISTS "webhookDeliveryId"'), "MirrorMutationJournal.webhookDeliveryId column missing");
  assert.ok(migration.includes('MirrorMutationJournal_webhookDelivery_fkey'), "MirrorMutationJournal foreign key constraint missing");
});

test("applyProductUpsertMutation transitions WebhookDelivery to PROCESSED and persists webhookDeliveryId on journal", async () => {
  const { webhookDeliveries, mutationJournals, dbClient } = createFakeCorrelationDb();

  webhookDeliveries.set("del_123", {
    id: "del_123",
    shop: "store.myshopify.com",
    status: "QUEUED",
    statusNormalized: "QUEUED",
  });

  const journal = await applyProductUpsertMutation({
    shop: "store.myshopify.com",
    productId: "gid://shopify/Product/1",
    mirrorBatchId: "batch_1",
    mutationType: "PRODUCT_UPDATE",
    productData: { title: "New Product" },
    variants: [],
    sourceEventOccurredAt: new Date(),
    webhookDeliveryId: "del_123",
    dbClient,
  });

  assert.ok(journal.sequence);
  assert.equal(webhookDeliveries.get("del_123").statusNormalized, "PROCESSED");
  assert.equal(webhookDeliveries.get("del_123").status, "PROCESSED");
  assert.ok(webhookDeliveries.get("del_123").processedAt instanceof Date);

  assert.equal(mutationJournals.length, 1);
  assert.equal(mutationJournals[0].webhookDeliveryId, "del_123");
});

test("applyProductUpsertMutation throws WEBHOOK_DELIVERY_COMPLETION_REJECTED when delivery is missing or not QUEUED/RECEIVED", async () => {
  const { dbClient } = createFakeCorrelationDb();

  await assert.rejects(
    () => applyProductUpsertMutation({
      shop: "store.myshopify.com",
      productId: "gid://shopify/Product/1",
      mirrorBatchId: "batch_1",
      mutationType: "PRODUCT_UPDATE",
      productData: { title: "New Product" },
      variants: [],
      sourceEventOccurredAt: new Date(),
      webhookDeliveryId: "non_existent_delivery",
      dbClient,
    }),
    (err) => {
      assert.equal(err.code, "WEBHOOK_DELIVERY_COMPLETION_REJECTED");
      return true;
    },
  );
});

test("privacy.js queueProductWebhook includes webhookDeliveryId in queue payload", () => {
  const privacySrc = fs.readFileSync(new URL("./privacy.js", import.meta.url), "utf8");
  assert.ok(
    privacySrc.includes("webhookDeliveryId: reservation.deliveryId") ||
    privacySrc.includes("webhookDeliveryId: deliveryId"),
    "privacy.js must pass webhookDeliveryId in queue payloads",
  );
});
