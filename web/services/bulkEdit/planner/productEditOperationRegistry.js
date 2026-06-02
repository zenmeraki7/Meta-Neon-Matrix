const API_STRATEGIES = Object.freeze({
  BULK_MUTATION: "BULK_MUTATION",
  CHUNKED_API: "CHUNKED_API",
  BULK_OR_CHUNKED: "BULK_OR_CHUNKED",
});

export const PRODUCT_EDIT_OPERATIONS = Object.freeze({
  TITLE_SET: {
    target: "PRODUCT",
    mutation: "productUpdate",
    apiStrategy: API_STRATEGIES.BULK_MUTATION,
    undoable: true,
    requiresBeforeSnapshot: true,
    requiresVerification: true,
    requiredScopes: ["write_products"],
  },
  VARIANT_PRICE_SET: {
    target: "VARIANT",
    mutation: "productVariantsBulkUpdate",
    apiStrategy: API_STRATEGIES.BULK_MUTATION,
    undoable: true,
    requiresBeforeSnapshot: true,
    requiresVerification: true,
    requiredScopes: ["write_products"],
  },
  INVENTORY_SET: {
    target: "INVENTORY_LEVEL",
    mutation: "inventorySetOnHandQuantities",
    apiStrategy: API_STRATEGIES.CHUNKED_API,
    undoable: true,
    requiresBeforeSnapshot: true,
    requiresVerification: true,
    requiredScopes: ["write_inventory"],
  },
  METAFIELD_SET: {
    target: "METAFIELD",
    mutation: "metafieldsSet",
    apiStrategy: API_STRATEGIES.BULK_OR_CHUNKED,
    undoable: true,
    requiresBeforeSnapshot: true,
    requiresVerification: true,
    requiredScopes: ["write_products"],
  },
  COLLECTION_ADD: {
    target: "COLLECTION_MEMBERSHIP",
    mutation: "collectionAddProductsV2",
    apiStrategy: API_STRATEGIES.CHUNKED_API,
    undoable: true,
    requiresBeforeSnapshot: true,
    requiresVerification: true,
    requiredScopes: ["write_products"],
  },
  COLLECTION_REMOVE: {
    target: "COLLECTION_MEMBERSHIP",
    mutation: "collectionRemoveProducts",
    apiStrategy: API_STRATEGIES.CHUNKED_API,
    undoable: true,
    requiresBeforeSnapshot: true,
    requiresVerification: true,
    requiredScopes: ["write_products"],
  },
  PRODUCT_DELETE: {
    target: "PRODUCT",
    mutation: "productSet",
    apiStrategy: API_STRATEGIES.BULK_MUTATION,
    undoable: false,
    requiresBeforeSnapshot: true,
    requiresVerification: true,
    requiredScopes: ["write_products"],
  },
  PRODUCT_GENERIC_SET: {
    target: "PRODUCT",
    mutation: "productUpdate",
    apiStrategy: API_STRATEGIES.BULK_MUTATION,
    undoable: true,
    requiresBeforeSnapshot: true,
    requiresVerification: true,
    requiredScopes: ["write_products"],
  },
  VARIANT_GENERIC_SET: {
    target: "VARIANT",
    mutation: "productVariantsBulkUpdate",
    apiStrategy: API_STRATEGIES.BULK_MUTATION,
    undoable: true,
    requiresBeforeSnapshot: true,
    requiresVerification: true,
    requiredScopes: ["write_products"],
  },
  MEDIA_SET: {
    target: "PRODUCT",
    mutation: "productCreateMedia",
    apiStrategy: API_STRATEGIES.CHUNKED_API,
    undoable: false,
    requiresBeforeSnapshot: false,
    requiresVerification: true,
    requiredScopes: ["write_products"],
  },
});

const INVENTORY_FIELDS = new Set(["inventory", "inventoryPolicy", "tracked", "cost"]);
const METAFIELD_FIELDS = new Set(["metafield", "metafields"]);
const COLLECTION_FIELDS = new Set(["collection", "collections"]);
const VARIANT_FIELDS = new Set([
  "price",
  "compareAtPrice",
  "sku",
  "barcode",
  "taxable",
  "requiresShipping",
  "weight",
  "weightUnit",
  "option1Values",
  "option2Values",
  "option3Values",
]);
const MEDIA_FIELDS = new Set(["media", "featuredMedia", "image", "images"]);

function hasAny(fields, set) {
  return fields.some((f) => set.has(f));
}

export function resolveProductEditOperation({
  mutationIntent = {},
  fieldsBeingEdited = [],
  targetGranularity = "PRODUCT",
} = {}) {
  const fields = Array.isArray(fieldsBeingEdited)
    ? [...new Set(fieldsBeingEdited.filter(Boolean).map((f) => String(f).trim()))]
    : [];
  const intent = String(mutationIntent?.mutationType || mutationIntent?.operationType || "")
    .trim()
    .toUpperCase();
  const variantGranularity = String(targetGranularity || "PRODUCT").toUpperCase() === "VARIANT";

  if (intent.includes("DELETE")) return "PRODUCT_DELETE";
  if (intent.includes("METAFIELD") || hasAny(fields, METAFIELD_FIELDS)) return "METAFIELD_SET";
  if (intent.includes("COLLECTION_REMOVE")) return "COLLECTION_REMOVE";
  if (intent.includes("COLLECTION") || hasAny(fields, COLLECTION_FIELDS)) return "COLLECTION_ADD";
  if (intent.includes("INVENTORY") || hasAny(fields, INVENTORY_FIELDS)) return "INVENTORY_SET";
  if (intent.includes("MEDIA") || hasAny(fields, MEDIA_FIELDS)) return "MEDIA_SET";
  if (fields.includes("title")) return "TITLE_SET";
  if (fields.includes("price")) return "VARIANT_PRICE_SET";
  if (variantGranularity || hasAny(fields, VARIANT_FIELDS)) return "VARIANT_GENERIC_SET";
  return "PRODUCT_GENERIC_SET";
}

export const ProductEditOperationRegistry = Object.freeze({
  API_STRATEGIES,
  PRODUCT_EDIT_OPERATIONS,
  resolveProductEditOperation,
});

export function assertValidOperationKey(operationKey) {
  const key = String(operationKey || "").trim();
  if (!key) {
    const error = new Error("OPERATION_KEY_REQUIRED");
    error.code = "OPERATION_KEY_REQUIRED";
    throw error;
  }
  if (!Object.prototype.hasOwnProperty.call(PRODUCT_EDIT_OPERATIONS, key)) {
    const error = new Error(`UNKNOWN_OPERATION_KEY:${key}`);
    error.code = "UNKNOWN_OPERATION_KEY";
    throw error;
  }
  return key;
}
