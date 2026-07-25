import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FIELD_CONFIGS } from "./helpers/productBulkOperationHelpers/constants.js";

const schemaPath = path.resolve("web/prisma/schema.prisma");

const FIELD_TO_MIRROR_COLUMN_OVERRIDES = Object.freeze({
  // Substring description search is covered by the SQL-managed trigram GIN index.
  description: null,
  // Raw status is source-preservation only; normalized status is authoritative.
  status: "statusNormalized",
  inventory: "inventoryQuantity",
  metaTitle: null,
  metaDescription: null,
  deleteProducts: null,
  tags: null,
  collections: null,
  category: "categoryName",
  // Low-selectivity booleans must not require full B-tree indexes.
  taxable: null,
  googleShoppingCustomLabel0: null,
  googleShoppingCustomLabel1: null,
  googleShoppingCustomLabel2: null,
  googleShoppingCustomLabel3: null,
  googleShoppingCustomLabel4: null,
  categoryFabric: null,
  categoryFit: null,
  categoryWaistRise: null,
  option1Values: "option1Value",
  option2Values: "option2Value",
  option3Values: "option3Value",
});

function normalizeRegistryColumn(field, config = {}) {
  if (Object.prototype.hasOwnProperty.call(FIELD_TO_MIRROR_COLUMN_OVERRIDES, field)) {
    return FIELD_TO_MIRROR_COLUMN_OVERRIDES[field];
  }
  const fieldName = String(config.fieldName || field || "").trim();
  if (!fieldName) return null;
  const normalized = fieldName.charAt(0).toLowerCase() + fieldName.slice(1);
  if (/[^a-zA-Z0-9_]/.test(normalized)) return null;
  return normalized;
}

function expectedCompositeIndexesFromRegistry() {
  const productCols = new Set();
  const variantCols = new Set();

  for (const [field, config] of Object.entries(FIELD_CONFIGS || {})) {
    const col = normalizeRegistryColumn(field, config || {});
    if (!col) continue;
    if (config?.isVariantLevel) variantCols.add(col);
    else productCols.add(col);
  }

  return {
    product: [...productCols].map((col) => `@@index([shop, mirrorBatchId, ${col}])`),
    variant: [...variantCols].map((col) => `@@index([shop, mirrorBatchId, ${col}])`),
  };
}

test("registry-derived mirror composite indexes are present for product/variant fields", () => {
  const source = fs.readFileSync(schemaPath, "utf8");
  const expected = expectedCompositeIndexesFromRegistry();

  const missing = [];
  for (const pattern of [...expected.product, ...expected.variant]) {
    const withIdPattern = pattern.replace("])", ", id])");
    if (!source.includes(pattern) && !source.includes(withIdPattern)) {
      missing.push(pattern);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `Missing registry-driven mirror indexes:\n${missing.join("\n")}`,
  );
});
