import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const source = fs.readFileSync("web/repositories/productQueryRepository.js", "utf8");

test("product listing repository bounds pagination", () => {
  assert.match(source, /const MAX_LISTING_TAKE = 250/);
  assert.match(source, /const MAX_LISTING_SKIP = 100_000/);
  assert.match(source, /function safeListingTake\(take\)/);
  assert.match(source, /throw new Error\(`take must not exceed \$\{MAX_LISTING_TAKE\}`\)/);
  assert.match(source, /skip: safeListingSkip\(skip\)/);
  assert.match(source, /take: safeListingTake\(take\)/);
});

test("product listing repository validates where shape before spreading", () => {
  assert.match(source, /const PRODUCT_SCALAR_FIELDS = new Set/);
  assert.match(source, /const PRISMA_FILTER_OPERATORS = new Set/);
  assert.match(source, /function assertSafeWhere\(where,/);
  assert.match(source, /MAX_WHERE_DEPTH/);
  assert.match(source, /MAX_WHERE_ARRAY_LENGTH/);
  assert.match(source, /must not include scoped field \$\{key\}/);
  assert.match(source, /findProductsForListing\.where/);
  assert.match(source, /countProducts\.where/);
});

test("variant distinct queries use an explicit variant batch resolver", () => {
  assert.match(source, /async function resolveActiveVariantBatchId/);
  assert.match(source, /Product and variant mirrors are versioned by the same activeMirrorBatchId/);
  assert.match(source, /const scopedMirrorBatchId = await resolveActiveVariantBatchId\(scopedShop, mirrorBatchId\)/);
});

test("product tag raw sql documents Prisma table and columns", () => {
  assert.match(source, /Raw SQL intentionally targets the Prisma Product model table\/columns/);
  assert.match(source, /"Product"\."shop", "Product"\."mirrorBatchId", and "Product"\."tags"/);
});
