import test from "node:test";
import assert from "node:assert/strict";
import { toProductQueryResponseDto } from "./dtos/productQueryDto.js";

test("product query DTO emits one canonical product and variant identity contract", () => {
  const response = toProductQueryResponseDto({
    shopDomain: "example.myshopify.com",
    mirrorBatchId: "batch-1",
    products: [{
      id: "123",
      title: "Shirt",
      variants: [{ id: "456" }],
    }],
  });

  assert.deepEqual(response.data.products[0], {
    id: "gid://shopify/Product/123",
    productId: "gid://shopify/Product/123",
    rowKey: "example.myshopify.com:batch-1:gid://shopify/Product/123",
    title: "Shirt",
    variants: [{
      id: "gid://shopify/ProductVariant/456",
      variantId: "gid://shopify/ProductVariant/456",
      productId: "gid://shopify/Product/123",
      rowKey: "example.myshopify.com:batch-1:gid://shopify/ProductVariant/456",
    }],
  });
});

test("product query DTO rejects ambiguous non-Shopify identities", () => {
  assert.throws(
    () => toProductQueryResponseDto({
      shopDomain: "example.myshopify.com",
      mirrorBatchId: "batch-1",
      products: [{ id: "database-cuid" }],
    }),
    { code: "INVALID_PRODUCT_IDENTITY" },
  );
});
