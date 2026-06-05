import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toProductGridDto } from "./dtos/productGridDto.js";

const repositorySource = readFileSync(
  new URL("./repositories/productGridRepository.js", import.meta.url),
  "utf8",
);
const productsSource = readFileSync(
  new URL("../db/products.js", import.meta.url),
  "utf8",
);

test("product grid pushes productType and tag filters into product listing query", () => {
  assert.match(productsSource, /normalizedProductType/);
  assert.match(productsSource, /p\.product_type = \$\{normalizedProductType\}/);
  assert.match(productsSource, /p\.tags \? \$\{normalizedTag\}/);
  assert.doesNotMatch(repositorySource, /filteredProducts|tagFilteredProducts/);
});

test("product grid repository does not blindly BigInt product or variant ids", () => {
  assert.doesNotMatch(repositorySource, /BigInt\(/);
  assert.match(repositorySource, /toSafeNumericIds/);
});

test("product grid dto reports matching total, not page row count", () => {
  const dto = toProductGridDto({
    listed: {
      nextCursor: "cursor-1",
      total: 1234,
    },
    products: [
      {
        id: "1",
        title: "Product 1",
        handle: "product-1",
        status: "ACTIVE",
        vendor: "Vendor",
        productType: "Gadget",
        tags: ["featured"],
      },
    ],
    variants: [
      {
        id: "10",
        product_id: "1",
        title: "Default",
        sku: "SKU-1",
        price: "10.00",
        inventory_quantity: 5,
        position: 1,
        option_values: [],
      },
    ],
    metafields: [],
  });

  assert.equal(dto.rows.length, 1);
  assert.equal(dto.total, 1234);
  assert.equal(dto.nextCursor, "cursor-1");
});

test("product grid dto only materializes metafields that exist", () => {
  const dto = toProductGridDto({
    listed: { total: 1, nextCursor: null },
    products: [{ id: "1", title: "P", handle: "p", tags: [] }],
    variants: [{ id: "10", product_id: "1", option_values: [] }],
    metafields: [
      {
        variant_id: "10",
        namespace: "custom",
        key: "color",
        value: "blue",
        pending_value: null,
        edit_status: "SYNCED",
        type: "single_line_text_field",
      },
    ],
  });

  assert.deepEqual(Object.keys(dto.rows[0].metafields), ["custom.color"]);
});
