import test from "node:test";
import assert from "node:assert/strict";
import {
  bulkEditExecuteSchema,
  bulkEditPreviewSchema,
  exportRequestSchema,
  subscriptionCreateSchema,
} from "./validations/controllerRequestSchemas.js";

const validPreviewId = "6f1d5bbf-1c74-4d53-8f79-61cc1c84b6d1";
const validFilterHash = "a".repeat(64);
const validMirrorBatchId = "product_sync_1710000000000_6f1d5bbf-1c74-4d53-8f79-61cc1c84b6d1";

function validExecutePayload(overrides = {}) {
  return {
    editedField: "title",
    editType: "replace",
    editValue: "New title",
    previewId: validPreviewId,
    previewFilterHash: validFilterHash,
    previewMirrorBatchId: validMirrorBatchId,
    previewFieldRegistryVersion: "fields-v1",
    previewOperatorRegistryVersion: "operators-v1",
    ...overrides,
  };
}

test("bulk edit execute schema normalizes non-conflicting aliases", () => {
  const { error, value } = bulkEditExecuteSchema.validate(validExecutePayload({
    editedField: undefined,
    field: "vendor",
    editType: undefined,
    editedType: "set",
    editValue: undefined,
    value: "Acme",
  }));

  assert.equal(error, undefined);
  assert.equal(value.editedField, "vendor");
  assert.equal(value.editType, "set");
  assert.equal(value.editValue, "Acme");
  assert.equal("field" in value, false);
  assert.equal("editedType" in value, false);
  assert.equal("value" in value, false);
});

test("bulk edit execute schema rejects ambiguous aliases", () => {
  const { error } = bulkEditExecuteSchema.validate(validExecutePayload({
    field: "vendor",
  }));

  assert.ok(error);
  assert.match(error.message, /contains a conflict/);
});

test("bulk edit execute schema bounds critical inputs", () => {
  assert.ok(bulkEditExecuteSchema.validate(validExecutePayload({
    editValue: "x".repeat(5_001),
  })).error);
  assert.ok(bulkEditExecuteSchema.validate(validExecutePayload({
    productIds: Array.from({ length: 5_001 }, (_, index) => `gid://shopify/Product/${index}`),
  })).error);
  assert.ok(bulkEditExecuteSchema.validate(validExecutePayload({
    previewId: "not-a-uuid",
  })).error);
  assert.ok(bulkEditExecuteSchema.validate(validExecutePayload({
    previewFilterHash: "not-a-sha",
  })).error);
  assert.ok(bulkEditExecuteSchema.validate(validExecutePayload({
    previewMirrorBatchId: "x",
  })).error);
});

test("filter params reject extra fields and oversized values", () => {
  assert.ok(bulkEditPreviewSchema.validate({
    field: "title",
    editType: "replace",
    editValue: "New title",
    filterParams: [{
      field: "vendor",
      operator: "equals",
      value: "Acme",
      rawWhere: { unsafe: true },
    }],
  }).error);

  assert.ok(bulkEditPreviewSchema.validate({
    field: "title",
    editType: "replace",
    editValue: "New title",
    filterParams: [{
      field: "vendor",
      operator: "equals",
      value: "x".repeat(5_001),
    }],
  }).error);
});

test("export fields and subscription return url are bounded", () => {
  assert.ok(exportRequestSchema.validate({
    fields: Array.from({ length: 101 }, (_, index) => `field${index}`),
    fileName: "products.csv",
  }).error);

  assert.ok(subscriptionCreateSchema.validate({
    planKey: "starter",
    returnUrl: null,
  }).error);
});
