import { TargetingValidationError } from "../errors/TargetingValidationError.js";

const ALL_CONTEXTS = Object.freeze(["PREVIEW", "EXECUTE", "SCHEDULED", "RECURRING", "EXPORT"]);

function def(config) {
  return Object.freeze({
    key: config.key,
    model: config.model,
    column: config.column,
    valueType: config.valueType,
    operators: Object.freeze(config.operators),
    granularities: Object.freeze(config.granularities),
    contexts: Object.freeze(config.contexts || ALL_CONTEXTS),
    indexed: Boolean(config.indexed),
    relation: config.relation || null,
    pathKind: config.pathKind || "scalar",
    // Back-compat aliases for current validator/compiler.
    entity: config.model === "Variant" ? "VARIANT" : "PRODUCT",
    prismaPath: config.column,
    allowedGranularities: Object.freeze(config.granularities),
  });
}

export const fieldRegistry = Object.freeze({
  // Product fields
  vendor: def({
    key: "vendor",
    model: "Product",
    column: "vendor",
    valueType: "string",
    operators: ["EQ", "NEQ", "CONTAINS", "NOT_CONTAINS", "IN", "NOT_IN", "IS_EMPTY", "IS_NOT_EMPTY"],
    granularities: ["PRODUCT", "PRODUCT_WITH_MATCHING_VARIANTS"],
    indexed: true,
  }),
  title: def({
    key: "title",
    model: "Product",
    column: "title",
    valueType: "string",
    operators: ["EQ", "NEQ", "CONTAINS", "NOT_CONTAINS", "STARTS_WITH", "ENDS_WITH", "IS_EMPTY", "IS_NOT_EMPTY"],
    granularities: ["PRODUCT", "PRODUCT_WITH_MATCHING_VARIANTS"],
    indexed: true,
  }),
  productType: def({
    key: "productType",
    model: "Product",
    column: "productType",
    valueType: "string",
    operators: ["EQ", "NEQ", "IN", "NOT_IN", "IS_EMPTY", "IS_NOT_EMPTY"],
    granularities: ["PRODUCT", "PRODUCT_WITH_MATCHING_VARIANTS"],
    indexed: true,
  }),
  handle: def({
    key: "handle",
    model: "Product",
    column: "handle",
    valueType: "string",
    operators: ["EQ", "NEQ", "CONTAINS", "STARTS_WITH", "ENDS_WITH", "IS_EMPTY", "IS_NOT_EMPTY"],
    granularities: ["PRODUCT", "PRODUCT_WITH_MATCHING_VARIANTS"],
    indexed: true,
  }),
  status: def({
    key: "status",
    model: "Product",
    column: "status",
    valueType: "string",
    operators: ["EQ", "NEQ", "IN", "NOT_IN"],
    granularities: ["PRODUCT", "PRODUCT_WITH_MATCHING_VARIANTS"],
    indexed: true,
  }),
  createdAt: def({
    key: "createdAt",
    model: "Product",
    column: "createdAt",
    valueType: "date",
    operators: ["EQ", "LT", "LTE", "GT", "GTE", "BETWEEN"],
    granularities: ["PRODUCT", "PRODUCT_WITH_MATCHING_VARIANTS"],
    indexed: true,
  }),
  updatedAt: def({
    key: "updatedAt",
    model: "Product",
    column: "updatedAt",
    valueType: "date",
    operators: ["EQ", "LT", "LTE", "GT", "GTE", "BETWEEN"],
    granularities: ["PRODUCT", "PRODUCT_WITH_MATCHING_VARIANTS"],
    indexed: true,
  }),
  publishedAt: def({
    key: "publishedAt",
    model: "Product",
    column: "publishedAt",
    valueType: "date",
    operators: ["EQ", "LT", "LTE", "GT", "GTE", "BETWEEN", "IS_EMPTY", "IS_NOT_EMPTY"],
    granularities: ["PRODUCT", "PRODUCT_WITH_MATCHING_VARIANTS"],
    indexed: true,
  }),

  // Variant fields
  sku: def({
    key: "sku",
    model: "Variant",
    column: "sku",
    valueType: "string",
    operators: ["EQ", "NEQ", "CONTAINS", "NOT_CONTAINS", "IN", "NOT_IN", "IS_EMPTY", "IS_NOT_EMPTY"],
    granularities: ["VARIANT", "PRODUCT", "PRODUCT_WITH_MATCHING_VARIANTS"],
    indexed: true,
  }),
  barcode: def({
    key: "barcode",
    model: "Variant",
    column: "barcode",
    valueType: "string",
    operators: ["EQ", "NEQ", "CONTAINS", "NOT_CONTAINS", "IN", "NOT_IN", "IS_EMPTY", "IS_NOT_EMPTY"],
    granularities: ["VARIANT", "PRODUCT", "PRODUCT_WITH_MATCHING_VARIANTS"],
    indexed: true,
  }),
  price: def({
    key: "price",
    model: "Variant",
    column: "price",
    valueType: "number",
    operators: ["EQ", "NEQ", "LT", "LTE", "GT", "GTE", "BETWEEN", "IN", "NOT_IN"],
    granularities: ["VARIANT", "PRODUCT", "PRODUCT_WITH_MATCHING_VARIANTS"],
    indexed: true,
  }),
  compareAtPrice: def({
    key: "compareAtPrice",
    model: "Variant",
    column: "compareAtPrice",
    valueType: "number",
    operators: ["EQ", "NEQ", "LT", "LTE", "GT", "GTE", "BETWEEN", "IS_EMPTY", "IS_NOT_EMPTY"],
    granularities: ["VARIANT", "PRODUCT", "PRODUCT_WITH_MATCHING_VARIANTS"],
    indexed: true,
  }),
  inventoryQuantity: def({
    key: "inventoryQuantity",
    model: "Variant",
    column: "inventoryQuantity",
    valueType: "number",
    operators: ["EQ", "NEQ", "LT", "LTE", "GT", "GTE", "BETWEEN", "IN", "NOT_IN"],
    granularities: ["VARIANT", "PRODUCT", "PRODUCT_WITH_MATCHING_VARIANTS"],
    indexed: true,
  }),
  option1: def({
    key: "option1",
    model: "Variant",
    column: "option1Value",
    valueType: "string",
    operators: ["EQ", "NEQ", "CONTAINS", "NOT_CONTAINS", "IN", "NOT_IN", "IS_EMPTY", "IS_NOT_EMPTY"],
    granularities: ["VARIANT", "PRODUCT", "PRODUCT_WITH_MATCHING_VARIANTS"],
    indexed: true,
  }),
  option2: def({
    key: "option2",
    model: "Variant",
    column: "option2Value",
    valueType: "string",
    operators: ["EQ", "NEQ", "CONTAINS", "NOT_CONTAINS", "IN", "NOT_IN", "IS_EMPTY", "IS_NOT_EMPTY"],
    granularities: ["VARIANT", "PRODUCT", "PRODUCT_WITH_MATCHING_VARIANTS"],
    indexed: true,
  }),
  option3: def({
    key: "option3",
    model: "Variant",
    column: "option3Value",
    valueType: "string",
    operators: ["EQ", "NEQ", "CONTAINS", "NOT_CONTAINS", "IN", "NOT_IN", "IS_EMPTY", "IS_NOT_EMPTY"],
    granularities: ["VARIANT", "PRODUCT", "PRODUCT_WITH_MATCHING_VARIANTS"],
    indexed: true,
  }),

  // Product tags
  tags: def({
    key: "tags",
    model: "Product",
    column: "tags",
    valueType: "string[]",
    operators: ["IN", "NOT_IN", "IS_EMPTY", "IS_NOT_EMPTY", "EXISTS", "NOT_EXISTS"],
    granularities: ["PRODUCT", "PRODUCT_WITH_MATCHING_VARIANTS"],
    indexed: true,
    pathKind: "array",
  }),

  // Collections (relation)
  collections: def({
    key: "collections",
    model: "Product",
    column: "__relation:ProductCollection",
    valueType: "string[]",
    operators: ["IN", "NOT_IN", "EXISTS", "NOT_EXISTS"],
    granularities: ["PRODUCT", "PRODUCT_WITH_MATCHING_VARIANTS"],
    indexed: true,
    relation: "ProductCollectionMembership",
    pathKind: "relation",
  }),

  // Product metafields (relation)
  productMetafield: def({
    key: "productMetafield",
    model: "Product",
    column: "__relation:MetafieldMirror:PRODUCT",
    valueType: "string",
    operators: ["EQ", "NEQ", "CONTAINS", "NOT_CONTAINS", "EXISTS", "NOT_EXISTS", "IS_EMPTY", "IS_NOT_EMPTY"],
    granularities: ["PRODUCT", "PRODUCT_WITH_MATCHING_VARIANTS"],
    indexed: true,
    relation: "MetafieldMirror",
    pathKind: "relation",
  }),

  // Variant metafields (relation)
  variantMetafield: def({
    key: "variantMetafield",
    model: "Variant",
    column: "__relation:MetafieldMirror:VARIANT",
    valueType: "string",
    operators: ["EQ", "NEQ", "CONTAINS", "NOT_CONTAINS", "EXISTS", "NOT_EXISTS", "IS_EMPTY", "IS_NOT_EMPTY"],
    granularities: ["VARIANT", "PRODUCT", "PRODUCT_WITH_MATCHING_VARIANTS"],
    indexed: true,
    relation: "MetafieldMirror",
    pathKind: "relation",
  }),

  // Category / Google Shopping fields
  googleShoppingCategory: def({
    key: "googleShoppingCategory",
    model: "Product",
    column: "googleShoppingCategory",
    valueType: "string",
    operators: ["EQ", "NEQ", "CONTAINS", "NOT_CONTAINS", "IN", "NOT_IN", "IS_EMPTY", "IS_NOT_EMPTY"],
    granularities: ["PRODUCT", "PRODUCT_WITH_MATCHING_VARIANTS"],
    indexed: true,
  }),
  googleShoppingColor: def({
    key: "googleShoppingColor",
    model: "Product",
    column: "googleShoppingColor",
    valueType: "string",
    operators: ["EQ", "NEQ", "CONTAINS", "NOT_CONTAINS", "IN", "NOT_IN", "IS_EMPTY", "IS_NOT_EMPTY"],
    granularities: ["PRODUCT", "PRODUCT_WITH_MATCHING_VARIANTS"],
    indexed: true,
  }),
  categoryName: def({
    key: "categoryName",
    model: "Product",
    column: "categoryName",
    valueType: "string",
    operators: ["EQ", "NEQ", "CONTAINS", "NOT_CONTAINS", "IN", "NOT_IN", "IS_EMPTY", "IS_NOT_EMPTY"],
    granularities: ["PRODUCT", "PRODUCT_WITH_MATCHING_VARIANTS"],
    indexed: true,
  }),
});

export function getFieldSpecOrThrow(field) {
  const spec = fieldRegistry[field];
  if (!spec) {
    throw new TargetingValidationError("Unknown filter field", {
      code: "UNKNOWN_FIELD",
      meta: { field },
    });
  }
  return spec;
}
