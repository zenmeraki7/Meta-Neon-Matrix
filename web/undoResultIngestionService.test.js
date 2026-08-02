import test from "node:test";
import assert from "node:assert/strict";
import {
  UndoResultIngestionService,
  validateUndoResultUrl,
} from "./services/undo/UndoResultIngestionService.js";

test("validateUndoResultUrl accepts valid HTTPS Shopify storage URLs", () => {
  const validUrl =
    "https://shopify-tier-1-files.s3.amazonaws.com/bulk-results/12345.jsonl";
  assert.equal(validateUndoResultUrl(validUrl), validUrl);

  const shopifyCdn = "https://cdn.shopifycdn.net/files/test.jsonl";
  assert.equal(
    validateUndoResultUrl("https://my-store.myshopify.com/files/test.jsonl"),
    "https://my-store.myshopify.com/files/test.jsonl"
  );
});

test("validateUndoResultUrl rejects HTTP protocol", () => {
  assert.throws(
    () => validateUndoResultUrl("http://shopify-tier-1-files.s3.amazonaws.com/test.jsonl"),
    (err) => err.code === "UNDO_RESULT_URL_INVALID"
  );
});

test("validateUndoResultUrl rejects embedded credentials", () => {
  assert.throws(
    () =>
      validateUndoResultUrl(
        "https://admin:secret@shopify-tier-1-files.s3.amazonaws.com/test.jsonl"
      ),
    (err) => err.code === "UNDO_RESULT_URL_INVALID"
  );
});

test("validateUndoResultUrl rejects private, loopback and link-local destinations", () => {
  const dangerousUrls = [
    "https://localhost/test.jsonl",
    "https://127.0.0.1/test.jsonl",
    "https://10.0.0.1/test.jsonl",
    "https://172.16.0.1/test.jsonl",
    "https://192.168.1.1/test.jsonl",
    "https://169.254.169.254/latest/meta-data",
  ];

  for (const url of dangerousUrls) {
    assert.throws(
      () => validateUndoResultUrl(url),
      (err) => err.code === "UNDO_RESULT_URL_INVALID",
      `Expected ${url} to be rejected as SSRF target`
    );
  }
});

test("validateUndoResultUrl rejects non-allowlisted domains", () => {
  assert.throws(
    () => validateUndoResultUrl("https://attacker-controlled-server.com/test.jsonl"),
    (err) => err.code === "UNDO_RESULT_URL_INVALID"
  );
});

test("ingestUndoBulkOperationWebhook validates input before lease acquisition", async () => {
  const service = new UndoResultIngestionService();

  // Test invalid shop
  await assert.rejects(
    () =>
      service.ingestUndoBulkOperationWebhook({
        shop: "invalid-shop",
        shopifyBulkOperationId: "gid://shopify/BulkOperation/123",
      }),
    (err) => err.code === "UNDO_INVALID_WEBHOOK_INPUT"
  );

  // Test unknown input field
  await assert.rejects(
    () =>
      service.ingestUndoBulkOperationWebhook({
        shop: "valid-shop.myshopify.com",
        shopifyBulkOperationId: "gid://shopify/BulkOperation/123",
        resultUrl: "https://example.com/untrusted",
      }),
    (err) => err.code === "UNDO_INVALID_WEBHOOK_INPUT"
  );

  // Test invalid status
  await assert.rejects(
    () =>
      service.ingestUndoBulkOperationWebhook({
        shop: "valid-shop.myshopify.com",
        shopifyBulkOperationId: "gid://shopify/BulkOperation/123",
        status: "MALICIOUS_STATUS",
      }),
    (err) => err.code === "UNDO_INVALID_WEBHOOK_INPUT"
  );
});
