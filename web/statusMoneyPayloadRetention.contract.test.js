import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeProductStatus } from "./utils/productStatus.js";
import {
  buildImmutablePayloadMetadata,
  verifyImmutablePayload,
} from "./utils/immutablePayloadUtils.js";
import {
  addMoney,
  applyMoneyPercentage,
  canonicalizeMoney,
  percentageToRatio,
  percentageOfMoney,
} from "./utils/decimalArithmetic.js";
import {
  asMetafieldKey,
  asMetafieldNamespace,
  requireShopDomain,
} from "./utils/identity.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => fs.readFileSync(path.join(here, relative), "utf8");

test("raw Shopify status is retained and unknown values normalize without enum ingestion failure", () => {
  const schema = read("prisma/schema.prisma");
  const migration = read("prisma/migrations/20260801130000_status_money_payload_retention_hardening/migration.sql");
  assert.match(schema, /status\s+String/);
  assert.match(schema, /statusNormalized String @default\("UNKNOWN"\)/);
  assert.doesNotMatch(schema, /enum ShopifyProductStatus/);
  assert.equal(normalizeProductStatus("ACTIVE"), "ACTIVE");
  assert.equal(normalizeProductStatus("future_shopify_status"), "UNKNOWN");
  assert.match(migration, /ALTER COLUMN "statusNormalized" TYPE varchar\(32\)/);
  assert.match(migration, /'UNKNOWN'/);
});

test("money arithmetic is decimal, canonically rounded once, and margin is a ratio", () => {
  assert.equal(canonicalizeMoney("1.23456"), "1.2346");
  assert.equal(addMoney("0.1", "0.2"), "0.3000");
  assert.equal(applyMoneyPercentage("19.9900", "10", 1n), "21.9890");
  assert.equal(percentageOfMoney("19.9900", "25"), "4.9975");
  assert.equal(percentageToRatio("20"), "0.20000000");
  const schema = read("prisma/schema.prisma");
  const migration = read("prisma/migrations/20260801130000_status_money_payload_retention_hardening/migration.sql");
  assert.match(schema, /profitMarginRatio\s+Decimal\? @db\.Decimal\(12, 8\)/);
  assert.doesNotMatch(schema, /profitMargin\s+Decimal/);
  assert.match(migration, /MONEY_SCALE_OUTLIERS_PRESENT_IN_VARIANT/);
  assert.match(migration, /Variant_money_nonnegative_ck/);
});

test("durable payloads are canonical, bounded and integrity checked before execution", () => {
  const left = buildImmutablePayloadMetadata({ payload: { b: 2, a: [1, true] }, operationType: "OUTBOX_EVENT" });
  const right = buildImmutablePayloadMetadata({ payload: { a: [1, true], b: 2 }, operationType: "OUTBOX_EVENT" });
  assert.equal(left.payloadHash, right.payloadHash);
  assert.equal(left.payloadByteSize, right.payloadByteSize);
  assert.equal(verifyImmutablePayload({ a: [1, true], b: 2 }, { ...left, operationType: "OUTBOX_EVENT" }), true);
  assert.throws(
    () => verifyImmutablePayload({ a: [1, false], b: 2 }, { ...left, operationType: "OUTBOX_EVENT" }),
    /IMMUTABLE_PAYLOAD_INTEGRITY_FAILED/,
  );
  assert.throws(
    () => buildImmutablePayloadMetadata({ payload: { data: "x".repeat(140 * 1024) }, operationType: "OUTBOX_EVENT" }),
    /PAYLOAD_EXTERNAL_STORAGE_REQUIRED/,
  );
  const worker = read("workers/outboxDispatcherWorker.js");
  const freezeWorker = read("Jobs/Workers/targetFreezeQueueWorker.js");
  const enqueueService = read("services/operationEnqueueIntentService.js");
  const storage = read("services/storage/immutableObjectStorage.js");
  assert.match(worker, /verifyImmutablePayload\(event\.payloadJson/);
  assert.match(freezeWorker, /verifyTargetFreezeCommand\(command\)/);
  assert.match(enqueueService, /saveImmutablePayload/);
  assert.match(enqueueService, /loadImmutablePayload/);
  assert.match(storage, /payloads\/\$\{shop\}\/\$\{payloadHash\}\.json/);
});

test("tenant, GID-adjacent and metafield identities are bounded before persistence", () => {
  assert.equal(requireShopDomain(" Example-Shop.myshopify.com "), "example-shop.myshopify.com");
  assert.throws(() => requireShopDomain("example.com"), /INVALID_SHOP_DOMAIN/);
  assert.equal(asMetafieldNamespace("custom_namespace"), "custom_namespace");
  assert.equal(asMetafieldKey("short_key"), "short_key");
  assert.throws(() => asMetafieldKey("x".repeat(65)), /INVALID_METAFIELD_KEY/);
  const migration = read("prisma/migrations/20260801130000_status_money_payload_retention_hardening/migration.sql");
  assert.match(migration, /LegacyMalformedIdentity/);
  assert.match(migration, /NOT VALID/);
});

test("audit relations restrict deletion and cleanup is terminal plus retention gated", () => {
  const schema = read("prisma/schema.prisma");
  const service = read("services/retentionWorkflowService.js");
  const migration = read("prisma/migrations/20260801130000_status_money_payload_retention_hardening/migration.sql");
  assert.match(schema, /retentionUntil\s+DateTime\?/);
  assert.match(schema, /references: \[shop, id\], onDelete: Restrict/);
  assert.match(service, /status: \{ in: \["DISPATCHED", "FAILED"\] \}/);
  assert.match(service, /retentionUntil: \{ lte: now \}/);
  assert.match(service, /redactExpiredEditHistories/);
  assert.match(migration, /ON DELETE RESTRICT NOT VALID/);
  assert.match(migration, /terminal_retention_idx/);
  assert.doesNotMatch(migration, /DELETE FROM "EditHistory"/);
});
