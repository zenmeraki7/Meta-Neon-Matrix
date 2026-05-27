import test from "node:test";
import assert from "node:assert/strict";
import { enforceMirrorScope, enforceMirrorScopeSql } from "./services/targeting/enforceMirrorScope.js";

test("tenant scope always includes shop and mirrorBatchId", () => {
  const where = enforceMirrorScope({
    shop: "shop-a.myshopify.com",
    mirrorBatchId: "batch-a",
    where: { vendor: { contains: "Nike" } },
  });
  assert.ok(Array.isArray(where.AND));
  const serialized = JSON.stringify(where);
  assert.equal(serialized.includes('"shop":"shop-a.myshopify.com"'), true);
  assert.equal(serialized.includes('"mirrorBatchId":"batch-a"'), true);
});

test("sql scope guard parameterizes tenant predicates", () => {
  const scoped = enforceMirrorScopeSql({
    shop: "shop-a.myshopify.com",
    mirrorBatchId: "batch-a",
    sqlText: "\"vendor\" ILIKE $1",
    params: ["%Nike%"],
  });
  assert.ok(scoped.text.includes("shop"));
  assert.ok(scoped.text.includes("mirrorBatchId"));
  assert.equal(scoped.params.includes("shop-a.myshopify.com"), true);
  assert.equal(scoped.params.includes("batch-a"), true);
});
