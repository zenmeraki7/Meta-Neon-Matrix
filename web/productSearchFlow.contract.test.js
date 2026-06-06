import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const productTargetingSource = fs.readFileSync(
  "web/services/productService/productTargetingService.js",
  "utf8",
);
const useProductsSource = fs.readFileSync(
  "web/frontend/Domain/products/list/hooks/useProducts.js",
  "utf8",
);

test("global product search is split before normalized AST compilation", () => {
  assert.ok(
    productTargetingSource.includes("splitGlobalSearchFilters(filterParams)"),
    "product search filters must be removed before legacy filters are adapted to normalized AST",
  );
  assert.ok(
    productTargetingSource.includes("buildGlobalProductSearchWhere(searchFilters)"),
    "product search filters must become a dedicated global search where clause",
  );
  assert.match(
    productTargetingSource,
    /filterParams:\s*remainingFilters/,
    "normalized AST adapter must only receive non-search filters",
  );
});

test("global product search covers product, variant, and tag mirror fields", () => {
  for (const field of [
    "title",
    "handle",
    "vendor",
    "productType",
    "descriptionText",
    "categoryName",
    "seoTitle",
    "seoDescription",
    "sku",
    "barcode",
    "tags",
  ]) {
    assert.ok(
      productTargetingSource.includes(field),
      `global search should include ${field}`,
    );
  }
});

test("product React Query key is derived from the filter params being posted", () => {
  assert.ok(
    useProductsSource.includes("const resolvedFilterHash = filtersKey;"),
    "React Query cache key must track canonicalized filterParams, including search",
  );
  assert.ok(
    useProductsSource.includes("buildFilterAstFromLegacyFilters"),
    "product listing should post canonical filterAst when filters are present",
  );
  assert.ok(
    useProductsSource.includes("filterParams: normalizedFilters"),
    "temporary legacy filterParams should stay aligned with the filters used to build filterAst",
  );
});

test("product query endpoint prefers TargetingEngineService for canonical filterAst", () => {
  const productQueryServiceSource = fs.readFileSync(
    "web/services/productService/productQueryService.js",
    "utf8",
  );
  const commandServiceSource = fs.readFileSync(
    "web/services/productService/productQueryCommandService.js",
    "utf8",
  );

  assert.ok(commandServiceSource.includes("const filterAst = body.filterAst"));
  assert.ok(productQueryServiceSource.includes("TargetingEngineService.resolvePreviewTargets"));
  assert.ok(productQueryServiceSource.includes("filterAst"));
  assert.ok(productQueryServiceSource.includes("legacyFilterParams: null"));
  assert.ok(productQueryServiceSource.includes('source: "PRODUCT_LISTING"'));
  assert.equal(
    productQueryServiceSource.includes("resolveCanonicalProductTarget"),
    false,
    "product listing must not call the legacy Prisma compatibility resolver",
  );
});

test("canonical product preview ASTs force SQL execution even for scalar filters", () => {
  const targetingEngineSource = fs.readFileSync(
    "web/services/targeting/TargetingEngineService.js",
    "utf8",
  );

  assert.ok(
    targetingEngineSource.includes('flow === "PREVIEW" && targetType === TARGET_TYPES.PRODUCT && Boolean(filterAst)'),
    "product preview/listing ASTs must not fall back to the Prisma resolver for scalar-only filters",
  );
  assert.ok(
    targetingEngineSource.includes("!isProductListingFlow && !isEngineV2EnabledForFlow"),
    "product listing must not use the engine-v2 feature-flag fallback to the legacy resolver",
  );
});

test("no-filter product listing uses SQL pagination instead of Prisma fallback", () => {
  const targetingEngineSource = fs.readFileSync(
    "web/services/targeting/TargetingEngineService.js",
    "utf8",
  );

  assert.ok(targetingEngineSource.includes("!filterAst"));
  assert.ok(targetingEngineSource.includes('whereSql: "TRUE"'));
  assert.ok(targetingEngineSource.includes("resolveProductSqlPage"));
});

test("relation-aware product listing SQL uses keyset cursor pagination", () => {
  const targetingEngineSource = fs.readFileSync(
    "web/services/targeting/TargetingEngineService.js",
    "utf8",
  );

  assert.ok(
    targetingEngineSource.includes("decodeTargetingCursor(queryParams?.cursor)"),
    "relation-aware product listing must decode the incoming cursor",
  );
  assert.ok(
    targetingEngineSource.includes("buildProductSqlCursorClause"),
    "relation-aware product listing must build a cursor WHERE clause",
  );
  assert.ok(
    targetingEngineSource.includes('p."id" ${sort.cmp}'),
    "cursor clause must use keyset product id comparison",
  );
  assert.ok(
    targetingEngineSource.includes("ORDER BY ${sort.column} ${sort.dir}, p.\"id\" ${sort.dir}"),
    "relation-aware product listing must use deterministic keyset ordering",
  );
  assert.ok(
    targetingEngineSource.includes("pageLimit + 1"),
    "relation-aware product listing must fetch one extra row to determine hasNextPage",
  );
  assert.ok(
    targetingEngineSource.includes("nextCursor"),
    "relation-aware product listing must return a stable next cursor",
  );
});
