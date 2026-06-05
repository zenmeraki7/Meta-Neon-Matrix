const API_STRATEGIES = Object.freeze({
  BULK_MUTATION: "BULK_MUTATION",
  CHUNKED_API: "CHUNKED_API",
  BULK_OR_CHUNKED: "BULK_OR_CHUNKED",
});

const EXECUTION_PATHS = Object.freeze({
  BULK_OPERATION_RUN_MUTATION: "bulkOperationRunMutation",
  GRAPHQL_BATCH_MUTATIONS: "graphqlBatchMutations",
  METAFIELDS_SET: "metafieldsSet",
  COLLECTION_OPERATIONS: "collectionOperations",
  INVENTORY_MUTATIONS: "inventoryMutations",
  MEDIA_MUTATIONS: "mediaMutations",
});

export const PRODUCT_EDIT_OPERATIONS = Object.freeze({
  TITLE_SET: {
    target: "PRODUCT",
    mutation: "productUpdate",
    apiStrategy: API_STRATEGIES.BULK_MUTATION,
    executionPath: EXECUTION_PATHS.BULK_OPERATION_RUN_MUTATION,
    undoable: true,
    requiresBeforeSnapshot: true,
    requiresVerification: true,
    requiredScopes: ["write_products"],
  },
  VARIANT_PRICE_SET: {
    target: "VARIANT",
    mutation: "productVariantsBulkUpdate",
    apiStrategy: API_STRATEGIES.BULK_MUTATION,
    executionPath: EXECUTION_PATHS.BULK_OPERATION_RUN_MUTATION,
    undoable: true,
    requiresBeforeSnapshot: true,
    requiresVerification: true,
    requiredScopes: ["write_products"],
  },
  INVENTORY_SET: {
    target: "INVENTORY_LEVEL",
    mutation: "inventorySetOnHandQuantities",
    apiStrategy: API_STRATEGIES.CHUNKED_API,
    executionPath: EXECUTION_PATHS.INVENTORY_MUTATIONS,
    undoable: true,
    requiresBeforeSnapshot: true,
    requiresVerification: true,
    requiredScopes: ["write_inventory"],
  },
  INVENTORY_ADJUST: {
    target: "INVENTORY_LEVEL",
    mutation: "inventoryAdjustQuantities",
    apiStrategy: API_STRATEGIES.CHUNKED_API,
    executionPath: EXECUTION_PATHS.INVENTORY_MUTATIONS,
    undoable: true,
    requiresBeforeSnapshot: true,
    requiresVerification: true,
    requiredScopes: ["write_inventory"],
  },
  METAFIELD_SET: {
    target: "METAFIELD",
    mutation: "metafieldsSet",
    apiStrategy: API_STRATEGIES.BULK_OR_CHUNKED,
    executionPath: EXECUTION_PATHS.METAFIELDS_SET,
    undoable: true,
    requiresBeforeSnapshot: true,
    requiresVerification: true,
    requiredScopes: ["write_products"],
  },
  COLLECTION_ADD: {
    target: "COLLECTION_MEMBERSHIP",
    mutation: "collectionAddProductsV2",
    apiStrategy: API_STRATEGIES.CHUNKED_API,
    executionPath: EXECUTION_PATHS.COLLECTION_OPERATIONS,
    undoable: true,
    requiresBeforeSnapshot: true,
    requiresVerification: true,
    requiredScopes: ["write_collections"],
  },
  COLLECTION_REMOVE: {
    target: "COLLECTION_MEMBERSHIP",
    mutation: "collectionRemoveProducts",
    apiStrategy: API_STRATEGIES.CHUNKED_API,
    executionPath: EXECUTION_PATHS.COLLECTION_OPERATIONS,
    undoable: true,
    requiresBeforeSnapshot: true,
    requiresVerification: true,
    requiredScopes: ["write_collections"],
  },
  PRODUCT_DELETE: {
    target: "PRODUCT",
    mutation: "productDelete",
    apiStrategy: API_STRATEGIES.BULK_MUTATION,
    executionPath: EXECUTION_PATHS.BULK_OPERATION_RUN_MUTATION,
    undoable: false,
    requiresBeforeSnapshot: true,
    requiresVerification: true,
    requiredScopes: ["write_products"],
  },
  PRODUCT_GENERIC_SET: {
    target: "PRODUCT",
    mutation: "productUpdate",
    apiStrategy: API_STRATEGIES.BULK_MUTATION,
    executionPath: EXECUTION_PATHS.BULK_OPERATION_RUN_MUTATION,
    undoable: true,
    requiresBeforeSnapshot: true,
    requiresVerification: true,
    requiredScopes: ["write_products"],
  },
  VARIANT_GENERIC_SET: {
    target: "VARIANT",
    mutation: "productVariantsBulkUpdate",
    apiStrategy: API_STRATEGIES.BULK_MUTATION,
    executionPath: EXECUTION_PATHS.BULK_OPERATION_RUN_MUTATION,
    undoable: true,
    requiresBeforeSnapshot: true,
    requiresVerification: true,
    requiredScopes: ["write_products"],
  },
  MEDIA_SET: {
    target: "PRODUCT",
    mutation: "productCreateMedia",
    apiStrategy: API_STRATEGIES.CHUNKED_API,
    executionPath: EXECUTION_PATHS.MEDIA_MUTATIONS,
    undoable: false,
    requiresBeforeSnapshot: false,
    recoveryExpectation: "MEDIA_OPERATIONS_REQUIRE_POST_WRITE_VERIFICATION_AND_MANUAL_REPLAY_FROM_SOURCE_ASSETS",
    requiresVerification: true,
    requiredScopes: ["write_products"],
  },
});

const INVENTORY_FIELDS = new Set(["inventory", "inventoryPolicy", "tracked", "cost"]);
const INVENTORY_ADJUST_FIELDS = new Set([
  "inventoryAdjust",
  "inventoryAdjustment",
  "inventoryDelta",
  "adjustInventory",
]);
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
  "optionValues",
]);
const MEDIA_FIELDS = new Set(["media", "featuredMedia", "image", "images"]);

function hasAny(fields, set) {
  return fields.some((f) => set.has(f));
}

function buildResolutionMatches({ intent, fields, variantGranularity }) {
  const matches = [];
  if (intent.includes("DELETE")) matches.push("PRODUCT_DELETE");
  if (intent.includes("METAFIELD") || hasAny(fields, METAFIELD_FIELDS)) matches.push("METAFIELD_SET");
  if (intent.includes("COLLECTION_REMOVE")) matches.push("COLLECTION_REMOVE");
  else if (intent.includes("COLLECTION_ADD")) matches.push("COLLECTION_ADD");
  else if (intent.includes("COLLECTION") || hasAny(fields, COLLECTION_FIELDS)) {
    matches.push("COLLECTION_ADD");
  }
  if (
    intent.includes("INVENTORY_ADJUST") ||
    intent.includes("INVENTORY_DELTA") ||
    hasAny(fields, INVENTORY_ADJUST_FIELDS)
  ) {
    matches.push("INVENTORY_ADJUST");
  } else if (intent.includes("INVENTORY") || hasAny(fields, INVENTORY_FIELDS)) {
    matches.push("INVENTORY_SET");
  }
  if (intent.includes("MEDIA") || hasAny(fields, MEDIA_FIELDS)) matches.push("MEDIA_SET");
  if (fields.includes("title")) matches.push("TITLE_SET");
  if (fields.includes("price")) matches.push("VARIANT_PRICE_SET");
  if (variantGranularity || hasAny(fields, VARIANT_FIELDS)) matches.push("VARIANT_GENERIC_SET");
  return [...new Set(matches)];
}

function assertSingleResolution(matches) {
  if (matches.length <= 1) return;
  const error = new Error(`AMBIGUOUS_PRODUCT_EDIT_OPERATION:${matches.join(",")}`);
  error.code = "AMBIGUOUS_PRODUCT_EDIT_OPERATION";
  error.operationKeys = matches;
  throw error;
}

function assertCompleteOperationDefinition(key, operationDef) {
  const requiredStringFields = ["target", "mutation", "apiStrategy", "executionPath"];
  for (const field of requiredStringFields) {
    if (!String(operationDef?.[field] || "").trim()) {
      const error = new Error(`OPERATION_DEFINITION_INVALID:${key}:${field}`);
      error.code = "OPERATION_DEFINITION_INVALID";
      throw error;
    }
  }
  if (!Array.isArray(operationDef.requiredScopes) || operationDef.requiredScopes.length === 0) {
    const error = new Error(`OPERATION_DEFINITION_INVALID:${key}:requiredScopes`);
    error.code = "OPERATION_DEFINITION_INVALID";
    throw error;
  }
  if (!Object.values(API_STRATEGIES).includes(operationDef.apiStrategy)) {
    const error = new Error(`OPERATION_DEFINITION_INVALID:${key}:apiStrategy`);
    error.code = "OPERATION_DEFINITION_INVALID";
    throw error;
  }
  if (!Object.values(EXECUTION_PATHS).includes(operationDef.executionPath)) {
    const error = new Error(`OPERATION_DEFINITION_INVALID:${key}:executionPath`);
    error.code = "OPERATION_DEFINITION_INVALID";
    throw error;
  }
  return operationDef;
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
  const matches = buildResolutionMatches({ intent, fields, variantGranularity });
  assertSingleResolution(matches);
  if (matches[0]) return matches[0];

  // Deliberate generic default: no specialized field category was detected.
  return "PRODUCT_GENERIC_SET";
}

export const ProductEditOperationRegistry = Object.freeze({
  API_STRATEGIES,
  EXECUTION_PATHS,
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
  assertCompleteOperationDefinition(key, PRODUCT_EDIT_OPERATIONS[key]);
  return key;
}

for (const [key, operationDef] of Object.entries(PRODUCT_EDIT_OPERATIONS)) {
  assertCompleteOperationDefinition(key, operationDef);
}
