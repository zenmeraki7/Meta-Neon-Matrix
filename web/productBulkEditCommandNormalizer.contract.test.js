import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBulkEditExecuteCommand,
  buildBulkEditPreviewCommand,
  buildPreviewVariantDetailsCommand,
  buildScheduledEditCommand,
} from "./normalizers/productBulkEditCommandNormalizer.js";

const context = {
  shop: "test-shop.myshopify.com",
  actor: { id: "user-1", email: "merchant@example.com" },
};

const fingerprint = {
  previewId: "6f1d5bbf-1c74-4d53-8f79-61cc1c84b6d1",
  previewFilterHash: "a".repeat(64),
  previewMirrorBatchId: "product_sync_1710000000000_6f1d5bbf-1c74-4d53-8f79-61cc1c84b6d1",
  previewFieldRegistryVersion: "fields-v1",
  previewOperatorRegistryVersion: "operators-v1",
};

function executeBody(overrides = {}) {
  return {
    editedField: "tags",
    editType: "set",
    editValue: ["tag-one", "tag-two"],
    ...fingerprint,
    ...overrides,
  };
}

test("edit values may be immutable arrays", () => {
  const command = buildBulkEditExecuteCommand({
    ...context,
    body: executeBody(),
    idempotencyKey: "idem-1",
  });

  assert.deepEqual(command.editValue, ["tag-one", "tag-two"]);
  assert.equal(Object.isFrozen(command.editValue), true);
});

test("partial preview fingerprints are rejected coherently", () => {
  assert.throws(
    () => buildBulkEditPreviewCommand({
      ...context,
      body: {
        editedField: "title",
        editType: "set",
        editValue: "New title",
        previewId: fingerprint.previewId,
      },
    }),
    /Incomplete preview fingerprint/,
  );
});

test("preview variant details accepts Shopify GIDs and page beyond limit cap", () => {
  const command = buildPreviewVariantDetailsCommand({
    ...context,
    params: {
      previewId: fingerprint.previewId,
      productId: "gid://shopify/Product/1234567890",
    },
    query: {
      page: "251",
      limit: "50",
    },
  });

  assert.equal(command.productId, "gid://shopify/Product/1234567890");
  assert.equal(command.page, 251);
  assert.equal(command.limit, 50);
});

test("scheduled edits require a one minute scheduling buffer", () => {
  const soon = new Date(Date.now() + 30_000).toISOString();
  const later = new Date(Date.now() + 120_000).toISOString();

  assert.throws(
    () => buildScheduledEditCommand({
      ...context,
      body: {
        ...executeBody(),
        scheduledAt: soon,
        scheduledUndoAt: later,
        freezeMode: "STATIC_AT_SCHEDULE_CREATE",
      },
      idempotencyKey: "idem-scheduled",
    }),
    /must be at least 60 seconds in the future/,
  );
});
