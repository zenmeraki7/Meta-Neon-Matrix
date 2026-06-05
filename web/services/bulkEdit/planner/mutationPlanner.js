import {
  ProductEditOperationRegistry,
  resolveProductEditOperation,
  assertValidOperationKey,
} from "./productEditOperationRegistry.js";
import { requireShopScope } from "../../../utils/shopScope.js";

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

const RISK_MATRIX = Object.freeze([
  {
    when: ({ count, supportsUndo }) => !supportsUndo && count >= 100_000,
    level: RISK_LEVELS.CRITICAL,
  },
  {
    when: ({ count }) => count >= 100_000,
    level: RISK_LEVELS.HIGH,
  },
  {
    when: ({ requiresBeforeSnapshot, supportsUndo }) => requiresBeforeSnapshot && !supportsUndo,
    level: RISK_LEVELS.HIGH,
  },
  {
    when: ({ count }) => count >= 10_000,
    level: RISK_LEVELS.MODERATE,
  },
  {
    when: ({ requiresBeforeSnapshot }) => requiresBeforeSnapshot,
    level: RISK_LEVELS.MODERATE,
  },
]);

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

function resolveShopPlanLimits(shop, shopPlanLimits) {
  if (!shopPlanLimits || typeof shopPlanLimits !== "object" || Array.isArray(shopPlanLimits)) {
    return {};
  }
  const perShop = shopPlanLimits.byShop || shopPlanLimits.shops || null;
  if (perShop && typeof perShop === "object" && !Array.isArray(perShop)) {
    return {
      ...shopPlanLimits,
      ...(perShop[shop] || {}),
    };
  }
  return shopPlanLimits;
}

function chooseBatchSize({ executionPath, targetCount, shopPlanLimits }) {
  const count = Number(targetCount || 0);
  const limits = shopPlanLimits && typeof shopPlanLimits === "object" ? shopPlanLimits : {};

  const explicit = Number(limits.batchSize || 0);
  if (explicit > 0) return explicit;

  const maxBatchSize = Number(limits.maxBatchSize || 0);
  const planClamp = (value) => (maxBatchSize > 0 ? Math.min(value, maxBatchSize) : value);

  if (executionPath === EXECUTION_PATHS.BULK_OPERATION_RUN_MUTATION) return planClamp(1000);
  if (executionPath === EXECUTION_PATHS.GRAPHQL_BATCH_MUTATIONS) return planClamp(count > 10_000 ? 250 : 100);
  if (executionPath === EXECUTION_PATHS.INVENTORY_MUTATIONS) return planClamp(100);
  if (executionPath === EXECUTION_PATHS.MEDIA_MUTATIONS) return planClamp(25);
  return planClamp(100);
}

function inferRiskLevel({
  targetCount = 0,
  supportsUndo = true,
  requiresBeforeSnapshot = false,
}) {
  const count = Number(targetCount || 0);
  const context = { count, supportsUndo, requiresBeforeSnapshot };
  const match = RISK_MATRIX.find((entry) => entry.when(context));
  if (match) return match.level;
  return RISK_LEVELS.LOW;
}

function resolveCostUnits(executionPath) {
  if (executionPath === EXECUTION_PATHS.BULK_OPERATION_RUN_MUTATION) return 2;
  if (executionPath === EXECUTION_PATHS.INVENTORY_MUTATIONS) return 14;
  if (executionPath === EXECUTION_PATHS.MEDIA_MUTATIONS) return 20;
  if (executionPath === EXECUTION_PATHS.METAFIELDS_SET) return 12;
  return 10;
}

function assertPlanType(planType) {
  const normalized = String(planType || PLAN_TYPES.BULK_EDIT).toUpperCase();
  if (!Object.values(PLAN_TYPES).includes(normalized)) {
    const error = new Error(`UNKNOWN_PLAN_TYPE:${normalized}`);
    error.code = "UNKNOWN_PLAN_TYPE";
    throw error;
  }
  return normalized;
}

function assertOperationDefinition(operationKey, operationDef) {
  if (!operationDef) {
    const error = new Error(`OPERATION_DEFINITION_MISSING:${operationKey}`);
    error.code = "OPERATION_DEFINITION_MISSING";
    throw error;
  }
  return operationDef;
}

function resolveExecutionPath({ operationKey, operationDef, targetCount }) {
  const registryStrategy = String(operationDef.apiStrategy || "").toUpperCase();
  const registryExecutionPath = String(operationDef.executionPath || "").trim();
  if (!registryStrategy) {
    const error = new Error(`OPERATION_API_STRATEGY_MISSING:${operationKey}`);
    error.code = "OPERATION_API_STRATEGY_MISSING";
    throw error;
  }

  if (registryStrategy === "BULK_OR_CHUNKED") {
    return Number(targetCount || 0) > 2_000
      ? EXECUTION_PATHS.BULK_OPERATION_RUN_MUTATION
      : registryExecutionPath || EXECUTION_PATHS.GRAPHQL_BATCH_MUTATIONS;
  }

  if (!registryExecutionPath) {
    const error = new Error(`OPERATION_EXECUTION_PATH_MISSING:${operationKey}`);
    error.code = "OPERATION_EXECUTION_PATH_MISSING";
    throw error;
  }

  if (
    registryStrategy !== "CHUNKED_API" &&
    registryStrategy !== "BULK_MUTATION"
  ) {
    const error = new Error(`OPERATION_API_STRATEGY_UNSUPPORTED:${operationKey}:${registryStrategy}`);
    error.code = "OPERATION_API_STRATEGY_UNSUPPORTED";
    throw error;
  }

  return registryExecutionPath;
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
  const scopedShop = requireShopScope(shop);
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
  const operationDef = assertOperationDefinition(
    resolvedOperationKey,
    ProductEditOperationRegistry.PRODUCT_EDIT_OPERATIONS[resolvedOperationKey],
  );

  const graphqlMutationName = operationDef.mutation || MUTATION_NAMES.PRODUCT_UPDATE;
  const requiredScopes = Array.isArray(operationDef.requiredScopes)
    ? operationDef.requiredScopes
    : ["write_products"];
  const supportsUndo = operationDef.undoable !== false;
  const requiresVerificationRead = operationDef.requiresVerification !== false;
  const requiresBeforeSnapshot = operationDef.requiresBeforeSnapshot === true;
  const executionPath = resolveExecutionPath({
    operationKey: resolvedOperationKey,
    operationDef,
    targetCount,
  });

  const batchSize = chooseBatchSize({
    executionPath,
    targetCount,
    shopPlanLimits: resolveShopPlanLimits(scopedShop, shopPlanLimits),
  });
  const chunkCount = Math.max(1, Math.ceil(Number(targetCount || 0) / Number(batchSize || 1)));
  const apiStrategy = executionPath === EXECUTION_PATHS.BULK_OPERATION_RUN_MUTATION
    ? API_STRATEGIES.BULK_OPERATION
    : API_STRATEGIES.CHUNKED_GRAPHQL;
  const costUnit = resolveCostUnits(executionPath);
  const estimatedCost = chunkCount * costUnit;
  const riskLevel = inferRiskLevel({
    targetCount,
    supportsUndo,
    requiresBeforeSnapshot,
  });
  const resolvedOperationId = String(operationId || "").trim() || null;
  const resolvedPlanType = assertPlanType(planType);

  return {
    operationKey: resolvedOperationKey,
    operationId: resolvedOperationId,
    shop: scopedShop,
    planType: resolvedPlanType,
    targetType: String(targetGranularity || "PRODUCT").toUpperCase(),
    mutationType: graphqlMutationName,
    apiStrategy,
    estimatedCost,
    estimatedCostUnit: "planner_weight_units",
    costUnit,
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
