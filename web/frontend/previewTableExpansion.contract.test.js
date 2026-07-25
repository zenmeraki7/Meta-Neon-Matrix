import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function read(file) {
  return fs.readFileSync(path.resolve(file), "utf8");
}

test("preview table expansion is isolated to memoized row components", () => {
  const previewTable = read(
    "web/frontend/Domain/products/edit/components/PreviewTable.jsx",
  );

  assert.ok(
    previewTable.includes("const PreviewTableRow = memo"),
    "PreviewTable must extract rows into a memoized row component",
  );
  assert.ok(
    !previewTable.includes("const rowFragments = useMemo"),
    "PreviewTable must not rebuild all row fragments from expandedRows",
  );
  assert.ok(
    previewTable.includes("isExpanded={expandedRowKey === rowKey}"),
    "PreviewTable should pass only the row expansion boolean to each memoized row",
  );
});

test("preview table allows only one expanded variant panel at a time", () => {
  const previewTable = read(
    "web/frontend/Domain/products/edit/components/PreviewTable.jsx",
  );

  assert.ok(
    previewTable.includes("const [expandedRowKey, setExpandedRowKey] = useState(null)"),
    "PreviewTable must track a single expanded row key",
  );
  assert.ok(
    previewTable.includes("current === rowKey ? null : rowKey"),
    "PreviewTable row toggle must collapse the current row or replace it",
  );
  assert.ok(
    !previewTable.includes("new Set(previous)") &&
      !previewTable.includes("expandedRows"),
    "PreviewTable must not allow unbounded concurrently expanded rows",
  );
});

test("preview table itemCount includes the expanded detail row", () => {
  const previewTable = read(
    "web/frontend/Domain/products/edit/components/PreviewTable.jsx",
  );

  assert.ok(
    previewTable.includes("const expandedItemCount = expandedRowKey ? 1 : 0"),
    "PreviewTable must compute the extra expanded detail row count",
  );
  assert.ok(
    previewTable.includes("itemCount={safeProducts.length + expandedItemCount}"),
    "PreviewTable IndexTable itemCount must include the expanded detail row",
  );
});

test("preview table expanded variant rows use unique DOM ids", () => {
  const previewTable = read(
    "web/frontend/Domain/products/edit/components/PreviewTable.jsx",
  );

  assert.ok(
    previewTable.includes("const expandedRowId = `${rowKey}:variants-row`"),
    "Expanded variant row id must be unique",
  );
  assert.ok(
    previewTable.includes("const expandedPanelId = `${rowKey}:variants-panel`"),
    "Expanded variant panel id must be unique",
  );
  assert.ok(
    previewTable.includes("id={expandedRowId}") &&
      previewTable.includes("id={expandedPanelId}"),
    "Expanded row and panel must use separate ids",
  );
  assert.ok(
    previewTable.includes("position={index + 1}"),
    "Expanded variant rows should not reuse the product row position",
  );
  assert.ok(
    !previewTable.includes('id={`${rowKey}:variants`}'),
    "Expanded row and panel must not share the old duplicate id",
  );
});

test("preview table requires stable row identity", () => {
  const previewTable = read(
    "web/frontend/Domain/products/edit/components/PreviewTable.jsx",
  );

  assert.ok(
    previewTable.includes('throw new Error("Preview row is missing stable identity.")'),
    "PreviewTable must reject preview rows without stable identity",
  );
  assert.ok(
    !previewTable.includes("return `preview:${index}`") &&
      !previewTable.includes("handle:${handle}"),
    "PreviewTable must not fall back to unstable index or handle keys",
  );
  assert.ok(
    previewTable.includes("invalidRowCount") &&
      previewTable.includes("invalidPreviewRowsHidden"),
    "PreviewTable must hide invalid rows with a critical merchant-visible warning",
  );
});

test("preview table variant details avoid heavy expansion and refetch flicker", () => {
  const previewTable = read(
    "web/frontend/Domain/products/edit/components/PreviewTable.jsx",
  );

  assert.ok(
    previewTable.includes("const VARIANT_DETAILS_PAGE_LIMIT = 25"),
    "Variant detail page size should stay capped at 25 rows",
  );
  assert.ok(
    previewTable.includes("const MAX_EXPANDED_VARIANTS = 25"),
    "Variant detail rendered row cap should stay at 25",
  );
  assert.ok(
    previewTable.includes("if (variantDetailsQuery.isLoading)") &&
      !previewTable.includes("variantDetailsQuery.isLoading || variantDetailsQuery.isFetching"),
    "VariantDetailsSection should only skeleton on initial load",
  );
  assert.ok(
    previewTable.includes("refreshingVariantDetails"),
    "VariantDetailsSection should show a subtle refetch indicator without hiding loaded rows",
  );
});

test("preview table memoized children do not receive translation function props", () => {
  const previewTable = read(
    "web/frontend/Domain/products/edit/components/PreviewTable.jsx",
  );

  assert.ok(
    previewTable.includes('useTranslation(["products", "common"])'),
    "PreviewTable child components should own translation hooks",
  );
  assert.ok(
    !previewTable.includes(" t,") &&
      !previewTable.includes(" t={t}") &&
      !previewTable.includes("variants={rows} t={t}"),
    "PreviewTable must not pass t through memoized row/detail components",
  );
});

test("preview table uses resilient product thumbnails", () => {
  const previewTable = read(
    "web/frontend/Domain/products/edit/components/PreviewTable.jsx",
  );
  const editPreviewPage = read(
    "web/frontend/Domain/products/edit/pages/EditPreviewPage.jsx",
  );

  assert.ok(
    previewTable.includes("const ResilientProductThumbnail = memo") &&
      previewTable.includes("onError={handleImageError}") &&
      previewTable.includes("setThumbnailSource(FALLBACK_PRODUCT_IMAGE)"),
    "PreviewTable must fallback when merchant product image URLs fail to load",
  );
  assert.ok(
    editPreviewPage.includes("EMPTY_PREVIEW_ROWS") &&
      editPreviewPage.includes("Array.isArray(previewData?.rows)"),
    "EditPreviewPage must avoid recreating empty preview row arrays",
  );
});

test("preview table renders safer diff and product identity details", () => {
  const previewTable = read(
    "web/frontend/Domain/products/edit/components/PreviewTable.jsx",
  );

  for (const renderer of [
    "MoneyDiff",
    "InventoryDiff",
    "MetafieldDiff",
    "SeoDiff",
    "TagDiff",
    "CollectionDiff",
    "JsonMetafieldDiff",
  ]) {
    assert.ok(
      previewTable.includes(renderer),
      `PreviewTable must include field-aware renderer ${renderer}`,
    );
  }

  assert.ok(
    previewTable.includes("StructuredValuePreview") &&
      previewTable.includes("View full diff"),
    "PreviewTable must expose structured previews for complex values",
  );
  assert.ok(
    !previewTable.includes("[complex value]"),
    "PreviewTable must not hide object diffs behind [complex value]",
  );
  assert.ok(
    previewTable.includes("getSecondaryProductIdentifier") &&
      previewTable.includes("product?.handle") &&
      previewTable.includes("SKU"),
    "PreviewTable rows must show a secondary product identifier",
  );
  assert.ok(
    previewTable.includes('tone={changedCount > 0 ? "success" : undefined}'),
    "PreviewTable changed-count badge must not use attention tone for zero changes",
  );
});

test("preview table empty state is preview-aware", () => {
  const previewTable = read(
    "web/frontend/Domain/products/edit/components/PreviewTable.jsx",
  );

  assert.ok(
    previewTable.includes("products:previewEmptyHeading") &&
      previewTable.includes("No changed preview rows") &&
      previewTable.includes("Preview is not ready"),
    "PreviewTable empty heading must handle non-filter empty states",
  );
  assert.ok(
    previewTable.includes("products:previewEmptyMessage") &&
      previewTable.includes("no-op") &&
      previewTable.includes("Generate a preview"),
    "PreviewTable empty message must explain preview/no-op states",
  );
});
