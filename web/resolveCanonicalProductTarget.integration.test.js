import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const prismaClientPath = path.join(__dirname, "generated", "prisma", "index.js");

const hasDb = Boolean(process.env.DATABASE_URL);
const hasGeneratedPrisma = fs.existsSync(prismaClientPath);

function makeShop() {
  const suffix = `${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  return `integration-${suffix}.myshopify.com`;
}

async function seedBaseMirror(shop, mirrorBatchId) {
  const { prisma } = await import("./config/database.js");
  await prisma.store.upsert({
    where: { shopUrl: shop },
    create: {
      shopUrl: shop,
      shopEmail: `${shop}.test@example.com`,
      currentProductMirrorBatchId: mirrorBatchId,
      mirrorHealthState: "HEALTHY",
      requiresMirrorRepair: false,
      staleReason: null,
      mirrorUnsafeSince: null,
    },
    update: {
      currentProductMirrorBatchId: mirrorBatchId,
      mirrorHealthState: "HEALTHY",
      requiresMirrorRepair: false,
      staleReason: null,
      mirrorUnsafeSince: null,
    },
  });

  await prisma.product.createMany({
    data: [
      {
        shop,
        id: "gid://shopify/Product/1",
        mirrorBatchId,
        title: "Summer Tee",
        status: "ACTIVE",
        vendor: "Acme",
        tags: ["summer", "cotton"],
      },
      {
        shop,
        id: "gid://shopify/Product/2",
        mirrorBatchId,
        title: "Summer Shorts",
        status: "ACTIVE",
        vendor: "Acme",
        tags: ["summer", "linen"],
      },
      {
        shop,
        id: "gid://shopify/Product/3",
        mirrorBatchId,
        title: "Winter Jacket",
        status: "ACTIVE",
        vendor: "North",
        tags: ["winter"],
      },
    ],
  });

  await prisma.variant.createMany({
    data: [
      {
        shop,
        id: "gid://shopify/ProductVariant/11",
        productId: "gid://shopify/Product/1",
        mirrorBatchId,
      },
      {
        shop,
        id: "gid://shopify/ProductVariant/12",
        productId: "gid://shopify/Product/2",
        mirrorBatchId,
      },
      {
        shop,
        id: "gid://shopify/ProductVariant/13",
        productId: "gid://shopify/Product/3",
        mirrorBatchId,
      },
    ],
  });

  await prisma.collection.createMany({
    data: [
      {
        shop,
        shopifyId: "gid://shopify/Collection/100",
        mirrorBatchId,
        title: "Summer Collection",
      },
      {
        shop,
        shopifyId: "gid://shopify/Collection/200",
        mirrorBatchId,
        title: "Clearance",
      },
    ],
  });

  await prisma.productCollection.createMany({
    data: [
      {
        shop,
        productId: "gid://shopify/Product/1",
        collectionId: "gid://shopify/Collection/100",
        mirrorBatchId,
      },
      {
        shop,
        productId: "gid://shopify/Product/2",
        collectionId: "gid://shopify/Collection/100",
        mirrorBatchId,
      },
      {
        shop,
        productId: "gid://shopify/Product/3",
        collectionId: "gid://shopify/Collection/200",
        mirrorBatchId,
      },
    ],
  });

  await prisma.metafieldMirror.createMany({
    data: [
      {
        shop,
        ownerType: "PRODUCT",
        ownerId: "gid://shopify/Product/1",
        namespace: "custom",
        key: "material",
        valueType: "single_line_text_field",
        valueText: "cotton",
        valueTextNormalized: "cotton",
        mirrorBatchId,
      },
      {
        shop,
        ownerType: "PRODUCT",
        ownerId: "gid://shopify/Product/2",
        namespace: "custom",
        key: "material",
        valueType: "single_line_text_field",
        valueText: "linen",
        valueTextNormalized: "linen",
        mirrorBatchId,
      },
      {
        shop,
        ownerType: "VARIANT",
        ownerId: "gid://shopify/ProductVariant/13",
        namespace: "custom",
        key: "country",
        valueType: "single_line_text_field",
        valueText: "india",
        valueTextNormalized: "india",
        mirrorBatchId,
      },
      {
        shop,
        ownerType: "PRODUCT",
        ownerId: "gid://shopify/Product/1",
        namespace: "custom",
        key: "rating",
        valueType: "number_decimal",
        valueText: "4.50",
        valueTextNormalized: "4.50",
        valueNumber: "4.50",
        mirrorBatchId,
      },
      {
        shop,
        ownerType: "PRODUCT",
        ownerId: "gid://shopify/Product/2",
        namespace: "custom",
        key: "rating",
        valueType: "number_decimal",
        valueText: "3.20",
        valueTextNormalized: "3.20",
        valueNumber: "3.20",
        mirrorBatchId,
      },
      {
        shop,
        ownerType: "PRODUCT",
        ownerId: "gid://shopify/Product/1",
        namespace: "custom",
        key: "available",
        valueType: "boolean",
        valueText: "true",
        valueTextNormalized: "true",
        valueBoolean: true,
        mirrorBatchId,
      },
      {
        shop,
        ownerType: "PRODUCT",
        ownerId: "gid://shopify/Product/2",
        namespace: "custom",
        key: "available",
        valueType: "boolean",
        valueText: "false",
        valueTextNormalized: "false",
        valueBoolean: false,
        mirrorBatchId,
      },
      {
        shop,
        ownerType: "PRODUCT",
        ownerId: "gid://shopify/Product/1",
        namespace: "custom",
        key: "release_date",
        valueType: "date",
        valueText: "2025-01-10",
        valueTextNormalized: "2025-01-10",
        valueDate: new Date("2025-01-10T00:00:00.000Z"),
        mirrorBatchId,
      },
      {
        shop,
        ownerType: "PRODUCT",
        ownerId: "gid://shopify/Product/2",
        namespace: "custom",
        key: "release_date",
        valueType: "date",
        valueText: "2024-01-10",
        valueTextNormalized: "2024-01-10",
        valueDate: new Date("2024-01-10T00:00:00.000Z"),
        mirrorBatchId,
      },
    ],
  });
}

async function cleanupShop(shop, mirrorBatchId) {
  const { prisma } = await import("./config/database.js");
  await prisma.targetSnapshot.deleteMany({ where: { shop } });
  await prisma.metafieldMirror.deleteMany({ where: { shop, mirrorBatchId } });
  await prisma.productCollection.deleteMany({ where: { shop, mirrorBatchId } });
  await prisma.collection.deleteMany({ where: { shop, mirrorBatchId } });
  await prisma.variant.deleteMany({ where: { shop, mirrorBatchId } });
  await prisma.product.deleteMany({ where: { shop, mirrorBatchId } });
  await prisma.store.deleteMany({ where: { shopUrl: shop } });
}

test("resolveCanonicalProductTarget uses normalized collection filter end-to-end", async (t) => {
  if (!hasDb) {
    t.skip("DATABASE_URL is not set");
    return;
  }
  if (!hasGeneratedPrisma) {
    t.skip("Generated Prisma client is missing (run prisma generate first)");
    return;
  }

  const shop = makeShop();
  const mirrorBatchId = `batch_${crypto.randomUUID()}`;

  await seedBaseMirror(shop, mirrorBatchId);

  t.after(async () => {
    await cleanupShop(shop, mirrorBatchId);
  });

  const { resolveCanonicalProductTarget } = await import(
    "./services/productService/productTargetingService.js"
  );

  const result = await resolveCanonicalProductTarget({
    shop,
    rawFilterInput: [
      {
        field: "collection",
        operator: "is",
        value: { id: "gid://shopify/Collection/100" },
      },
    ],
    queryParams: { page: 1, limit: 50, sortKey: "ID", sortOrder: "asc" },
    sampleLimit: 50,
  });

  assert.equal(result.mirrorBatchId, mirrorBatchId);
  const ids = result.sampleProducts.map((p) => p.id).sort();
  assert.deepEqual(ids, [
    "gid://shopify/Product/1",
    "gid://shopify/Product/2",
  ]);
  assert.equal(result.count, 2);
});

test("resolveCanonicalProductTarget applies normalized metafield filters with deterministic include/exclude", async (t) => {
  if (!hasDb) {
    t.skip("DATABASE_URL is not set");
    return;
  }
  if (!hasGeneratedPrisma) {
    t.skip("Generated Prisma client is missing (run prisma generate first)");
    return;
  }

  const shop = makeShop();
  const mirrorBatchId = `batch_${crypto.randomUUID()}`;

  await seedBaseMirror(shop, mirrorBatchId);

  t.after(async () => {
    await cleanupShop(shop, mirrorBatchId);
  });

  const { resolveCanonicalProductTarget } = await import(
    "./services/productService/productTargetingService.js"
  );

  const result = await resolveCanonicalProductTarget({
    shop,
    rawFilterInput: [
      {
        field: "metafield",
        operator: "contains",
        namespace: "custom",
        key: "material",
        value: "cot",
      },
      {
        field: "variant_metafield",
        operator: "contains",
        namespace: "custom",
        key: "country",
        value: "india",
      },
      {
        field: "collection",
        operator: "is not",
        value: "Clearance",
      },
    ],
    queryParams: { page: 1, limit: 50, sortKey: "ID", sortOrder: "asc" },
    sampleLimit: 50,
  });

  const ids = result.sampleProducts.map((p) => p.id).sort();
  assert.deepEqual(ids, []);
  assert.equal(result.count, 0);
});

test("resolveCanonicalProductTarget applies typed metafield comparisons (number/boolean/date)", async (t) => {
  if (!hasDb) {
    t.skip("DATABASE_URL is not set");
    return;
  }
  if (!hasGeneratedPrisma) {
    t.skip("Generated Prisma client is missing (run prisma generate first)");
    return;
  }

  const shop = makeShop();
  const mirrorBatchId = `batch_${crypto.randomUUID()}`;

  await seedBaseMirror(shop, mirrorBatchId);

  t.after(async () => {
    await cleanupShop(shop, mirrorBatchId);
  });

  const { resolveCanonicalProductTarget } = await import(
    "./services/productService/productTargetingService.js"
  );

  const result = await resolveCanonicalProductTarget({
    shop,
    rawFilterInput: [
      {
        field: "metafield",
        operator: ">",
        namespace: "custom",
        key: "rating",
        value: "4.0",
      },
      {
        field: "metafield",
        operator: "equals",
        namespace: "custom",
        key: "available",
        value: "true",
      },
      {
        field: "metafield",
        operator: "is after",
        namespace: "custom",
        key: "release_date",
        value: "2024-06-01",
      },
    ],
    queryParams: { page: 1, limit: 50, sortKey: "ID", sortOrder: "asc" },
    sampleLimit: 50,
  });

  const ids = result.sampleProducts.map((p) => p.id).sort();
  assert.deepEqual(ids, ["gid://shopify/Product/1"]);
  assert.equal(result.count, 1);
});

test("resolveCanonicalProductTarget supports keyset cursor pagination", async (t) => {
  if (!hasDb) {
    t.skip("DATABASE_URL is not set");
    return;
  }
  if (!hasGeneratedPrisma) {
    t.skip("Generated Prisma client is missing (run prisma generate first)");
    return;
  }

  const shop = makeShop();
  const mirrorBatchId = `batch_${crypto.randomUUID()}`;

  await seedBaseMirror(shop, mirrorBatchId);

  t.after(async () => {
    await cleanupShop(shop, mirrorBatchId);
  });

  const { resolveCanonicalProductTarget } = await import(
    "./services/productService/productTargetingService.js"
  );

  const page1 = await resolveCanonicalProductTarget({
    shop,
    rawFilterInput: [],
    queryParams: { limit: 2, sortKey: "ID", sortOrder: "asc" },
    sampleLimit: 2,
  });

  assert.equal(page1.sampleProducts.length, 2);
  assert.equal(page1.pagination.hasNextPage, true);
  assert.equal(typeof page1.pagination.nextCursor, "string");

  const page2 = await resolveCanonicalProductTarget({
    shop,
    rawFilterInput: [],
    queryParams: {
      limit: 2,
      sortKey: "ID",
      sortOrder: "asc",
      cursor: page1.pagination.nextCursor,
    },
    sampleLimit: 2,
  });

  const ids1 = page1.sampleProducts.map((p) => p.id);
  const ids2 = page2.sampleProducts.map((p) => p.id);
  assert.equal(page2.pagination.hasPrevPage, true);
  assert.equal(ids2.some((id) => ids1.includes(id)), false);
});
