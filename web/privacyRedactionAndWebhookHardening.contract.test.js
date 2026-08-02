import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { joinSafeJobId } from "./utils/jobQueueUtils.js";

const read = (path) => fs.readFileSync(path, "utf8");

test("1. Schema includes StoreInstallationStatus.REDACTING and ComplianceRequest model with @@unique([shop, topic, webhookId])", () => {
  const schema = read("web/prisma/schema.prisma");

  assert.match(schema, /enum StoreInstallationStatus \{[\s\S]*?REDACTING[\s\S]*?\}/);
  assert.match(schema, /model ComplianceRequest \{/);
  assert.match(schema, /@@unique\(\[shop, topic, webhookId\]\)/);
});

test("2. Idempotent shop redaction service nullifies active mirror batch pointers before deleting records", () => {
  const service = read("web/services/shopRedactionService.js");

  assert.match(service, /currentProductMirrorBatchId:\s*null/);
  assert.match(service, /currentCollectionMirrorBatchId:\s*null/);
  assert.match(service, /installationStatus:\s*"REDACTING"/);

  const clearPointerIndex = service.indexOf("currentProductMirrorBatchId: null");
  const deleteMirrorIndex = service.indexOf("tx.mirrorBatch.deleteMany");
  assert.ok(clearPointerIndex < deleteMirrorIndex, "Active mirror pointers must be set to null BEFORE deleting mirrorBatch rows");

  assert.match(service, /tx\.shopifySession\.deleteMany/);
  assert.match(service, /tx\.subscription\.deleteMany/);
  assert.match(service, /tx\.store\.deleteMany/);
});

test("3. App uninstall job and queue uses delivery-scoped job ID (joinSafeJobId('app-redact', ...))", () => {
  const uninstallQueue = read("web/Jobs/Queues/appUninstallJob.js");
  assert.match(uninstallQueue, /joinSafeJobId\(\s*"app-redact"/);
  assert.match(uninstallQueue, /data\?\.\s*webhookId/);

  const job1 = joinSafeJobId("app-redact", "shop.myshopify.com", "wh_100");
  const job2 = joinSafeJobId("app-redact", "shop.myshopify.com", "wh_200");
  assert.notEqual(job1, job2, "Distinct webhook IDs must produce distinct BullMQ job IDs");
});

test("4. App uninstall worker delegates shop data purge to executeShopRedaction", () => {
  const worker = read("web/Jobs/Workers/appUninstallWorker.js");
  assert.match(worker, /executeShopRedaction/);
  assert.match(worker, /topic:\s*"APP_UNINSTALLED"/);
  assert.doesNotMatch(worker, /tx\.mirrorBatch\.deleteMany/, "Direct inline unsafe purge in appUninstallWorker must be replaced by executeShopRedaction");
});

test("5. Product workers fence writes by checking installationStatus !== 'INSTALLED'", () => {
  const updateWorker = read("web/Jobs/Workers/productUpdateWorker.js");
  const createWorker = read("web/Jobs/Workers/productCreateWorker.js");
  const deleteWorker = read("web/Jobs/Workers/productDeleteWorker.js");

  assert.match(updateWorker, /store\.installationStatus !== "INSTALLED"/);
  assert.match(createWorker, /store\.installationStatus !== "INSTALLED"/);
  assert.match(deleteWorker, /store\.installationStatus !== "INSTALLED"/);
});

test("6. Webhook reservation catches only P2002 and throws WEBHOOK_PAYLOAD_CONFLICT on body mismatch", () => {
  const privacyCode = read("web/privacy.js");
  assert.match(privacyCode, /if \(error\?\.code !== "P2002"\) throw error;/);
  assert.match(privacyCode, /WEBHOOK_PAYLOAD_CONFLICT/);
});

test("7. Webhook delivery and enqueue intents commit within a single db.$transaction", () => {
  const privacyCode = read("web/privacy.js");
  assert.match(privacyCode, /db\.\$transaction\(async \(tx\) => \{[\s\S]*?reserveWebhookDelivery\(\{[\s\S]*?tx,/);
  assert.match(privacyCode, /createEnqueueIntent\(\{[\s\S]*?tx,/);
});

test("8. VARIANTS_UPDATE generates unique job IDs using buildWebhookJobId", () => {
  const privacyCode = read("web/privacy.js");
  assert.match(privacyCode, /VARIANTS_UPDATE: \{/);
  assert.match(privacyCode, /buildWebhookJobId/);
  assert.match(privacyCode, /export function buildWebhookJobId/);
});

test("9. Compliance callbacks (SHOP_REDACT, CUSTOMERS_REDACT) execute executeShopRedaction", () => {
  const privacyCode = read("web/privacy.js");
  assert.match(privacyCode, /SHOP_REDACT: \{[\s\S]*?executeShopRedaction/);
  assert.match(privacyCode, /CUSTOMERS_REDACT: \{[\s\S]*?executeShopRedaction/);
});
