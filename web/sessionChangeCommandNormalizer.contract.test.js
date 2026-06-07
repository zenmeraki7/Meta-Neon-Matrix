import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeColumnApplySessionChangesCommand,
  normalizeStageSessionChangesCommand,
} from "./normalizers/sessionChangeCommandNormalizer.js";

const locals = {
  shopify: { session: { shop: "example.myshopify.com" } },
  idempotencyKey: "1234567890abcdef",
};

test("session change route context separates auth and id validation failures", () => {
  assert.throws(
    () => normalizeStageSessionChangesCommand(
      { id: "session_1" },
      { changes: [{ variantId: "1", namespace: "custom", key: "badge", value: "x" }] },
      {},
    ),
    (error) => error.code === "UNAUTHENTICATED" && error.statusCode === 401,
  );

  assert.throws(
    () => normalizeStageSessionChangesCommand(
      {},
      { changes: [{ variantId: "1", namespace: "custom", key: "badge", value: "x" }] },
      locals,
    ),
    (error) =>
      error.code === "VALIDATION_FAILED"
      && error.statusCode === 400
      && error.fields?.[0]?.field === "id",
  );
});

test("session change route id is length bounded", () => {
  assert.throws(
    () => normalizeStageSessionChangesCommand(
      { id: "x".repeat(201) },
      { changes: [{ variantId: "1", namespace: "custom", key: "badge", value: "x" }] },
      locals,
    ),
    (error) => error.fields?.[0]?.field === "id" && error.fields?.[0]?.error === "invalid format",
  );
});

test("session change namespace and key must use Shopify-safe format", () => {
  assert.throws(
    () => normalizeStageSessionChangesCommand(
      { id: "session_1" },
      { changes: [{ variantId: "1", namespace: "bad namespace", key: "badge", value: "x" }] },
      locals,
    ),
    (error) =>
      error.fields?.[0]?.field === "changes.namespace"
      && error.fields?.[0]?.error === "invalid format",
  );

  assert.throws(
    () => normalizeColumnApplySessionChangesCommand(
      { id: "session_1" },
      { namespace: "custom", key: "bad key", value: "x", variantIds: ["1"] },
      locals,
    ),
    (error) => error.fields?.[0]?.field === "key" && error.fields?.[0]?.error === "invalid format",
  );
});

test("column apply variant ids are capped to 1000 items", () => {
  assert.throws(
    () => normalizeColumnApplySessionChangesCommand(
      { id: "session_1" },
      {
        namespace: "custom",
        key: "badge",
        value: "x",
        variantIds: Array.from({ length: 1001 }, (_, index) => String(index + 1)),
      },
      locals,
    ),
    (error) =>
      error.fields?.[0]?.field === "variantIds"
      && error.fields?.[0]?.error === "must be a non-empty array with max 1000 items",
  );
});

test("session change item rejects arrays as nested object values", () => {
  assert.throws(
    () => normalizeStageSessionChangesCommand(
      { id: "session_1" },
      { changes: [{ variantId: "1", namespace: "custom", key: "badge", value: ["x"] }] },
      locals,
    ),
    (error) =>
      error.fields?.[0]?.field === "changes.value"
      && error.fields?.[0]?.error === "nested objects are not allowed",
  );
});
