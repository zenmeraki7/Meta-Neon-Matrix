export const TARGETING_MODES = Object.freeze({
  STATIC: "STATIC",
  DYNAMIC: "DYNAMIC",
});

export const TARGET_GRANULARITIES = Object.freeze({
  PRODUCT: "PRODUCT",
  VARIANT: "VARIANT",
  PRODUCT_WITH_MATCHING_VARIANTS: "PRODUCT_WITH_MATCHING_VARIANTS",
});

export const TARGET_TYPES = Object.freeze({
  PRODUCT: "PRODUCT",
  VARIANT: "VARIANT",
});

export const FILTER_GROUP_LOGICS = Object.freeze(["AND", "OR"]);

export const FILTER_NODE_TYPES = Object.freeze({
  GROUP: "group",
  PREDICATE: "predicate",
});

export const AST_SCHEMA_VERSION = "1.0";
