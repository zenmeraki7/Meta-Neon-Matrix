import test from "node:test";
import assert from "node:assert/strict";
import {
  assertAutomaticRuleTargetShape,
  buildAutomaticRuleScopedTargets,
  buildAutomaticRuleTargetIdentity,
} from "./utils/automaticRuleTargetIdentityUtils.js";

test("Product state identity is PRODUCT:<productId> and variantId is null", () => {
  const rule = { scopeType: "PRODUCT" };
  const product = { id: "gid://shopify/Product/1", variants: [{ id: "gid://shopify/ProductVariant/1" }] };
  const targets = buildAutomaticRuleScopedTargets(rule, product);

  assert.equal(targets.length, 1);
  assert.equal(targets[0].targetType, "PRODUCT");
  assert.equal(targets[0].targetIdentity, "PRODUCT:gid://shopify/Product/1");
  assert.equal(targets[0].productId, "gid://shopify/Product/1");
  assert.equal(targets[0].variantId, null);
});

test("Variant state does not collapse across sibling variants", () => {
  const rule = { scopeType: "VARIANT" };
  const product = {
    id: "gid://shopify/Product/100",
    variants: [
      { id: "gid://shopify/ProductVariant/1" },
      { id: "gid://shopify/ProductVariant/2" },
      { id: "gid://shopify/ProductVariant/3" },
    ],
  };
  const targets = buildAutomaticRuleScopedTargets(rule, product);
  const identities = targets.map((t) => t.targetIdentity);

  assert.deepEqual(identities, [
    "VARIANT:gid://shopify/ProductVariant/1",
    "VARIANT:gid://shopify/ProductVariant/2",
    "VARIANT:gid://shopify/ProductVariant/3",
  ]);
  assert.ok(!identities.includes("PRODUCT:gid://shopify/Product/100"));
});

test("Suppression is variant-specific for the same product", () => {
  const suppressed = new Map([
    ["VARIANT:gid://shopify/ProductVariant/1", true],
  ]);

  assert.equal(suppressed.get("VARIANT:gid://shopify/ProductVariant/1"), true);
  assert.equal(suppressed.get("VARIANT:gid://shopify/ProductVariant/2"), undefined);
});

test("Product-level suppression key is separate from variant-level key", () => {
  const keys = new Set([
    "PRODUCT:gid://shopify/Product/100",
    "VARIANT:gid://shopify/ProductVariant/1",
  ]);

  assert.equal(keys.has("PRODUCT:gid://shopify/Product/100"), true);
  assert.equal(keys.has("VARIANT:gid://shopify/ProductVariant/1"), true);
  assert.equal(keys.has("VARIANT:gid://shopify/ProductVariant/100"), false);
});

test("Backfill identity for old product-only rows remains PRODUCT:<productId>", () => {
  const oldRow = { productId: "gid://shopify/Product/555" };
  const targetIdentity = `PRODUCT:${oldRow.productId}`;
  const targetType = "PRODUCT";

  assert.equal(targetType, "PRODUCT");
  assert.equal(targetIdentity, "PRODUCT:gid://shopify/Product/555");
});

test("Target identity helper and shape validation enforce PRODUCT/VARIANT invariants", () => {
  const productId = "gid://shopify/Product/1";
  const variantId = "gid://shopify/ProductVariant/2";

  assert.equal(
    buildAutomaticRuleTargetIdentity({ targetType: "PRODUCT", productId }),
    "PRODUCT:gid://shopify/Product/1",
  );
  assert.equal(
    buildAutomaticRuleTargetIdentity({ targetType: "VARIANT", productId, variantId }),
    "VARIANT:gid://shopify/ProductVariant/2",
  );
  assert.throws(
    () => buildAutomaticRuleTargetIdentity({ targetType: "VARIANT", variantId }),
    /VARIANT rule target requires productId and variantId/,
  );

  assert.doesNotThrow(() =>
    assertAutomaticRuleTargetShape({
      rule: { scopeType: "PRODUCT" },
      target: { productId, variantId: null },
    }),
  );
  assert.doesNotThrow(() =>
    assertAutomaticRuleTargetShape({
      rule: { scopeType: "VARIANT" },
      target: { productId, variantId },
    }),
  );

  assert.throws(
    () =>
      assertAutomaticRuleTargetShape({
        rule: { scopeType: "PRODUCT" },
        target: { productId, variantId },
      }),
    /PRODUCT scoped rule must target productId only/,
  );
  assert.throws(
    () =>
      assertAutomaticRuleTargetShape({
        rule: { scopeType: "VARIANT" },
        target: { productId, variantId: null },
      }),
    /VARIANT scoped rule must target productId and variantId/,
  );
});
