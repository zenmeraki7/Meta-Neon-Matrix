import crypto from "crypto";
import {
  ProductEditOperationRegistry,
  resolveProductEditOperation,
  assertValidOperationKey,
} from "./productEditOperationRegistry.js";

const EXECUTION_PATHS = Object.freeze({
  BULK_OPERATION_RUN_MUTATION: "bulkOperationRunMutation",
  GRAPHQL_BATCH_MUTATIONS: "graphqlBatchMutations",
  PRODUCT_UPDATE: "productUpdate",
  PRODUCT_VARIANTS_BULK_UPDATE: "productVariantsBulkUpdate",
  METAFIELDS_SET: "metafieldsSet",
  COLLECTION_OPERATIONS: "collectionOperations",
  INVENTORY_MUTATIONS: "inventoryMutations",
  MEDIA_MUTATIONS: "mediaMutations",
});

const PLAN_TYPES = Object.freeze({
  BULK_EDIT: "BULK_EDIT",
  SCHEDULED_EDIT: "SCHEDULED_EDIT",
  RECURRING_EDIT: "RECURRING_EDIT",
});

const API_STRATEGIES = Object.freeze({
  BULK_OPERATION: "BULK_OPERATION",
  CHUNKED_GRAPHQL: "CHUNKED_GRAPHQL",
});

const RISK_LEVELS = Object.freeze({
  LOW: "LOW",
  MODERATE: "MODERATE",
  HIGH: "HIGH",
  CRITICAL: "CRITICAL",
});

const MUTATION_NAMES = Object.freeze({
  PRODUCT_UPDATE: "productUpdate",
  PRODUCT_VARIANTS_BULK_UPDATE: "productVariantsBulkUpdate",
  METAFIELDS_SET: "metafieldsSet",
  PRODUCT_SET: "productSet",
  COLLECTION_ADD_PRODUCTS: "collectionAddProductsV2",
  COLLECTION_REMOVE_PRODUCTS: "collectionRemoveProducts",
  INVENTORY_SET_ON_HAND: "inventorySetOnHandQuantities",
  INVENTORY_ADJUST: "inventoryAdjustQuantities",
  PRODUCT_CREATE_MEDIA: "productCreateMedia",
  PRODUCT_DELETE_MEDIA: "productDeleteMedia",
});

function normalizeFields(fieldsBeingEdited) {
  if (!Array.isArray(fieldsBeingEdited)) return [];
  return [...new Set(fieldsBeingEdited.filter(Boolean).map((f) => String(f).trim()))];
}

function chooseBatchSize({ executionPath, targetCount, shopPlanLimits }) {
  const count = Number(targetCount || 0);
  const limits = shopPlanLimits && typeof shopPlanLimits === "object" ? shopPlanLimits : {};

  const explicit = Number(limits.batchSize || 0);
  if (explicit > 0) return explicit;

  if (executionPath === EXECUTION_PATHS.BULK_OPERATION_RUN_MUTATION) return 1000;
  if (executionPath === EXECUTION_PATHS.GRAPHQL_BATCH_MUTATIONS) return count > 10_000 ? 250 : 100;
  if (executionPath === EXECUTION_PATHS.INVENTORY_MUTATIONS) return 100;
  if (executionPath === EXECUTION_PATHS.MEDIA_MUTATIONS) return 25;
  return 100;
}

function inferRiskLevel({
  targetCount = 0,
  supportsUndo = true,
  requiresBeforeSnapshot = false,
}) {
  const count = Number(targetCount || 0);
  if (!supportsUndo && count >= 100_000) return RISK_LEVELS.CRITICAL;
  if (count >= 100_000 || (requiresBeforeSnapshot && !supportsUndo)) return RISK_LEVELS.HIGH;
  if (count >= 10_000 || requiresBeforeSnapshot) return RISK_LEVELS.MODERATE;
  return RISK_LEVELS.LOW;
}

function resolveCostUnits(executionPath) {
  if (executionPath === EXECUTION_PATHS.BULK_OPERATION_RUN_MUTATION) return 2;
  if (executionPath === EXECUTION_PATHS.INVENTORY_MUTATIONS) return 14;
  if (executionPath === EXECUTION_PATHS.MEDIA_MUTATIONS) return 20;
  if (executionPath === EXECUTION_PATHS.METAFIELDS_SET) return 12;
  return 10;
}

export function planMutationExecution({
  operationKey = null,
  operationId = null,
  shop = null,
  planType = PLAN_TYPES.BULK_EDIT,
  mutationIntent = {},
  targetGranularity = "PRODUCT",
  targetCount = 0,
  fieldsBeingEdited = [],
  shopPlanLimits = {},
} = {}) {
  const fields = normalizeFields(fieldsBeingEdited);
  const explicitOperationKey =
    String(operationKey || "").trim() ||
    String(mutationIntent?.operationKey || "").trim() ||
    null;
  const resolvedOperationKey = explicitOperationKey
    ? assertValidOperationKey(explicitOperationKey)
    : resolveProductEditOperation({
      mutationIntent,
      fieldsBeingEdited: fields,
      targetGranularity,
    });
  const operationDef = ProductEditOperationRegistry.PRODUCT_EDIT_OPERATIONS[resolvedOperationKey]
    || ProductEditOperationRegistry.PRODUCT_EDIT_OPERATIONS.PRODUCT_GENERIC_SET;

  let executionPath = EXECUTION_PATHS.GRAPHQL_BATCH_MUTATIONS;
  const graphqlMutationName = operationDef.mutation || MUTATION_NAMES.PRODUCT_UPDATE;
  const requiredScopes = Array.isArray(operationDef.requiredScopes)
    ? operationDef.requiredScopes
    : ["write_products"];
  const supportsUndo = operationDef.undoable !== false;
  const requiresVerificationRead = operationDef.requiresVerification !== false;
  const requiresBeforeSnapshot = operationDef.requiresBeforeSnapshot === true;

  const registryStrategy = String(operationDef.apiStrategy || "").toUpperCase();
  if (registryStrategy === "CHUNKED_API") {
    executionPath = graphqlMutationName.startsWith("inventory")
      ? EXECUTION_PATHS.INVENTORY_MUTATIONS
      : graphqlMutationName.startsWith("collection")
        ? EXECUTION_PATHS.COLLECTION_OPERATIONS
        : graphqlMutationName.startsWith("productCreateMedia") || graphqlMutationName.startsWith("productDeleteMedia")
          ? EXECUTION_PATHS.MEDIA_MUTATIONS
          : EXECUTION_PATHS.GRAPHQL_BATCH_MUTATIONS;
  } else if (registryStrategy === "BULK_OR_CHUNKED") {
    executionPath = Number(targetCount || 0) > 2_000
      ? EXECUTION_PATHS.BULK_OPERATION_RUN_MUTATION
      : EXECUTION_PATHS.GRAPHQL_BATCH_MUTATIONS;
  } else {
    executionPath = Number(targetCount || 0) > 5_000
      ? EXECUTION_PATHS.BULK_OPERATION_RUN_MUTATION
      : EXECUTION_PATHS.GRAPHQL_BATCH_MUTATIONS;
  }

  const batchSize = chooseBatchSize({
    executionPath,
    targetCount,
    shopPlanLimits,
  });
  const chunkCount = Math.max(1, Math.ceil(Number(targetCount || 0) / Number(batchSize || 1)));
  const apiStrategy = executionPath === EXECUTION_PATHS.BULK_OPERATION_RUN_MUTATION
    ? API_STRATEGIES.BULK_OPERATION
    : API_STRATEGIES.CHUNKED_GRAPHQL;
  const estimatedCost = chunkCount * resolveCostUnits(executionPath);
  const riskLevel = inferRiskLevel({
    targetCount,
    supportsUndo,
    requiresBeforeSnapshot,
  });
  const resolvedOperationId =
    String(operationId || "").trim() ||
    crypto.randomUUID();

  return {
    operationKey: resolvedOperationKey,
    operationId: resolvedOperationId,
    shop: String(shop || "").trim() || null,
    planType: String(planType || PLAN_TYPES.BULK_EDIT).toUpperCase(),
    targetType: String(targetGranularity || "PRODUCT").toUpperCase(),
    mutationType: graphqlMutationName,
    apiStrategy,
    estimatedCost,
    estimatedChunks: chunkCount,
    requiresBeforeSnapshot,
    requiresVerification: requiresVerificationRead === true,
    supportsUndo,
    riskLevel,

    // Back-compat for existing callers
    executionPath,
    requiredScopes,
    graphqlMutationName,
    batchSize,
    supportsUndo,
    requiresVerificationRead,
  };
}

export const MutationPlanner = Object.freeze({
  EXECUTION_PATHS,
  PLAN_TYPES,
  API_STRATEGIES,
  MUTATION_NAMES,
  RISK_LEVELS,
  ProductEditOperationRegistry,
  planMutationExecution,
});
