import test from "node:test";
import assert from "node:assert/strict";
import {
  asMirrorBatchId,
  asProductGid,
  asShopDomain,
  asStoreId,
  asVariantGid,
  requireShopDomain,
  requireStoreId,
} from "./utils/identity.js";

test("identity parsers normalize and preserve the correct identity kind", () => {
  assert.equal(asShopDomain(" Example-Shop.MyShopify.com "), "example-shop.myshopify.com");
  assert.equal(asStoreId("cm123store"), "cm123store");
  assert.equal(asMirrorBatchId("batch-123"), "batch-123");
  assert.equal(asProductGid("gid://shopify/Product/123"), "gid://shopify/Product/123");
  assert.equal(
    asVariantGid("gid://shopify/ProductVariant/456"),
    "gid://shopify/ProductVariant/456",
  );
});

test("identity parsers reject cross-kind and malformed values", () => {
  assert.throws(() => requireStoreId("example.myshopify.com"), {
    code: "INVALID_STORE_ID",
    message: "INVALID_STORE_ID",
  });
  assert.throws(() => requireShopDomain("cm123store"), {
    code: "INVALID_SHOP_DOMAIN",
    message: "INVALID_SHOP_DOMAIN",
  });
  assert.throws(() => asMirrorBatchId("example.myshopify.com"), {
    code: "MIRROR_BATCH_ID_IS_SHOP_DOMAIN",
  });
  assert.throws(() => asProductGid("gid://shopify/ProductVariant/123"), {
    code: "SHOPIFY_GID_INVALID",
  });
  assert.throws(() => asVariantGid("gid://shopify/Product/123"), {
    code: "SHOPIFY_GID_INVALID",
  });
});
