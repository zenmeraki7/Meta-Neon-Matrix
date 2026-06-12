import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeVariantGridQuery } from "./normalizers/variantGridQueryNormalizer.js";

test("/api/variants is mounted before the frontend catch-all", () => {
  const appSource = readFileSync(new URL("./app.js", import.meta.url), "utf8");

  assert.ok(
    appSource.includes('import variantsRoutes from "./routes/variants.js";'),
    "variants route module must be imported",
  );
  assert.ok(
    appSource.includes('app.use("/api/variants", variantsRoutes);'),
    "variants route must be mounted under /api/variants",
  );
});

test("variant grid normalizer derives shop from session locals and accepts product GIDs", () => {
  const command = normalizeVariantGridQuery(
    {},
    {
      limit: "500",
      productIds: [
        "gid://shopify/Product/123",
        "gid://shopify/Product/456",
      ],
    },
    {
      shop: "demo-shop.myshopify.com",
    },
  );

  assert.equal(command.shop, "demo-shop.myshopify.com");
  assert.equal(command.query.limit, 500);
  assert.deepEqual(command.query.productIds, [
    { gid: "gid://shopify/Product/123", numericId: "123" },
    { gid: "gid://shopify/Product/456", numericId: "456" },
  ]);
});
