import { TargetingValidationError } from "../errors/TargetingValidationError.js";
import {
  ProductEditOperationRegistry,
  resolveProductEditOperation,
} from "../../bulkEdit/planner/productEditOperationRegistry.js";

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
  "inventory",
  "inventoryPolicy",
  "cost",
]);

const PRODUCT_FIELDS = new Set([
  "title",
  "description",
  "vendor",
  "productType",
  "status",
  "tags",
  "handle",
]);

const REQUIRED_FIELDS = new Set(["title", "handle"]);

function deriveFieldsBeingEdited(mutationIntent = {}) {
  const explicit = Array.isArray(mutationIntent?.fieldsBeingEdited)
    ? mutationIntent.fieldsBeingEdited
    : [];
  const ruleFields = Array.isArray(mutationIntent?.mutationPayload?.rules)
    ? mutationIntent.mutationPayload.rules.map((rule) => rule?.field).filter(Boolean)
    : [];
  return [...new Set([...explicit, ...ruleFields].map((f) => String(f).trim()))];
}

function isDestructiveIntent(mutationIntent = {}) {
  const type = String(mutationIntent?.mutationType || mutationIntent?.operationType || "").toUpperCase();
  if (type.includes("DELETE")) return true;
  if (mutationIntent?.mutationPayload?.destructive === true) return true;
  return false;
}

function includesNonActiveStatusFilter(normalizedFilterAst) {
  if (!normalizedFilterAst) return false;
  const serialized = JSON.stringify(normalizedFilterAst).toLowerCase();
  return serialized.includes("draft") || serialized.includes("archived");
}

function formatCountForConfirmation(count) {
  return Number(count || 0).toLocaleString("en-US");
}

function buildRequiredCriticalConfirmation({ targetCount }) {
  return `EDIT ${formatCountForConfirmation(targetCount)} PRODUCTS`;
}

export function computeBlastRadiusRisk({
  targetCount = 0,
  totalCatalogCount = 0,
  fieldsEdited = [],
  destructiveNature = false,
  undoAvailability = true,
  verificationMode = "SAMPLE_PLUS_FAILURES",
} = {}) {
  const normalizedTargetCount = Number(targetCount || 0);
  const normalizedCatalogCount = Number(totalCatalogCount || 0);
  const targetPercentageOfCatalog = normalizedCatalogCount > 0
    ? normalizedTargetCount / normalizedCatalogCount
    : 0;
  const editedFields = Array.isArray(fieldsEdited) ? fieldsEdited.filter(Boolean) : [];
  const verification = String(verificationMode || "SAMPLE_PLUS_FAILURES").toUpperCase();

  let score = 0;
  if (normalizedTargetCount >= 250000) score += 60;
  else if (normalizedTargetCount >= 100000) score += 45;
  else if (normalizedTargetCount >= 10000) score += 25;
  else if (normalizedTargetCount >= 1000) score += 12;

  if (targetPercentageOfCatalog >= 0.9) score += 35;
  else if (targetPercentageOfCatalog >= 0.75) score += 25;
  else if (targetPercentageOfCatalog >= 0.5) score += 15;
  else if (targetPercentageOfCatalog >= 0.2) score += 8;

  score += Math.min(20, editedFields.length * 4);
  if (destructiveNature) score += 30;
  if (!undoAvailability) score += 20;
  if (verification === "NOT_REQUIRED") score += 8;
  if (verification === "NONE") score += 12;

  let riskLevel = "LOW";
  if (score >= 100) riskLevel = "CRITICAL";
  else if (score >= 70) riskLevel = "HIGH";
  else if (score >= 35) riskLevel = "MODERATE";

  return {
    riskLevel,
    riskScore: score,
    inputs: {
      targetCount: normalizedTargetCount,
      targetPercentageOfCatalog,
      fieldsEdited: editedFields,
      destructiveNature: destructiveNature === true,
      undoAvailability: undoAvailability !== false,
      verificationMode: verification,
      totalCatalogCount: normalizedCatalogCount,
    },
    requiredCriticalConfirmation: buildRequiredCriticalConfirmation({
      targetCount: normalizedTargetCount,
    }),
  };
}

export function validateBlastRadiusRisk({
  mutationIntent = null,
  targetCount = 0,
  totalCatalogCount = 0,
} = {}) {
  if (!mutationIntent || typeof mutationIntent !== "object") {
    return null;
  }

  const fields = deriveFieldsBeingEdited(mutationIntent);
  const destructiveNature = isDestructiveIntent(mutationIntent);
  const undoAvailability = mutationIntent?.undoAvailability !== false;
  const verificationMode =
    mutationIntent?.verificationMode ||
    mutationIntent?.verification?.mode ||
    "SAMPLE_PLUS_FAILURES";

  const assessment = computeBlastRadiusRisk({
    targetCount,
    totalCatalogCount,
    fieldsEdited: fields,
    destructiveNature,
    undoAvailability,
    verificationMode,
  });

  if (assessment.riskLevel === "CRITICAL") {
    const providedConfirmation = String(mutationIntent?.criticalConfirmationText || "").trim();
    if (providedConfirmation !== assessment.requiredCriticalConfirmation) {
      throw new TargetingValidationError("CRITICAL_BLAST_RADIUS_CONFIRMATION_REQUIRED", {
        code: "CRITICAL_BLAST_RADIUS_CONFIRMATION_REQUIRED",
        meta: {
          ...assessment,
          requiredTypedConfirmation: assessment.requiredCriticalConfirmation,
        },
      });
    }
  }

  return assessment;
}

export function validateMutationIntentPreflight({
  mutationIntent = null,
  targetGranularity = "PRODUCT",
  source = "MANUAL_PREVIEW",
  normalizedFilterAst = null,
} = {}) {
  if (!mutationIntent || typeof mutationIntent !== "object") {
    return;
  }

  const fields = deriveFieldsBeingEdited(mutationIntent);
  const granularity = String(targetGranularity || "PRODUCT").toUpperCase();
  const explicitOperationKey = String(mutationIntent?.operationKey || "").trim();
  if (explicitOperationKey) {
    const known = Object.prototype.hasOwnProperty.call(
      ProductEditOperationRegistry.PRODUCT_EDIT_OPERATIONS,
      explicitOperationKey,
    );
    if (!known) {
      throw new TargetingValidationError("Unknown operationKey", {
        code: "UNKNOWN_OPERATION_KEY",
        meta: { operationKey: explicitOperationKey },
      });
    }
    const inferredOperationKey = resolveProductEditOperation({
      mutationIntent,
      fieldsBeingEdited: fields,
      targetGranularity: granularity,
    });
    if (explicitOperationKey !== inferredOperationKey) {
      throw new TargetingValidationError("operationKey does not match mutation intent", {
        code: "OPERATION_KEY_MISMATCH",
        meta: { explicitOperationKey, inferredOperationKey },
      });
    }
  }

  if (granularity === "PRODUCT" && fields.some((field) => VARIANT_FIELDS.has(field))) {
    throw new TargetingValidationError(
      "Variant-level mutation cannot run on PRODUCT-only targeting",
      { code: "MUTATION_GRANULARITY_INCOMPATIBLE" },
    );
  }

  if (granularity === "VARIANT" && fields.some((field) => PRODUCT_FIELDS.has(field))) {
    throw new TargetingValidationError(
      "Product-level mutation cannot run on VARIANT-only targeting",
      { code: "MUTATION_GRANULARITY_INCOMPATIBLE" },
    );
  }

  if (fields.includes("inventory")) {
    const hasInventoryMapping = Boolean(
      mutationIntent?.mutationPayload?.locationId ||
      mutationIntent?.mutationPayload?.inventoryItemMappingReady,
    );
    if (!hasInventoryMapping) {
      throw new TargetingValidationError("Inventory edit requires inventory item/location mapping", {
        code: "INVENTORY_MAPPING_REQUIRED",
      });
    }
  }

  if (
    fields.includes("metafield") ||
    fields.includes("metafields") ||
    String(mutationIntent?.mutationType || "").toUpperCase().includes("METAFIELD")
  ) {
    const metafield = mutationIntent?.mutationPayload?.metafield || {};
    if (!metafield.namespace || !metafield.key || !metafield.type) {
      throw new TargetingValidationError("Metafield edit requires namespace/key/type", {
        code: "METAFIELD_DEFINITION_REQUIRED",
      });
    }
  }

  const clearedFields = Array.isArray(mutationIntent?.mutationPayload?.clearFields)
    ? mutationIntent.mutationPayload.clearFields.map((field) => String(field))
    : [];
  const clearsRequiredField = clearedFields.some((field) => REQUIRED_FIELDS.has(field));
  if (clearsRequiredField) {
    throw new TargetingValidationError("Required fields cannot be cleared", {
      code: "REQUIRED_FIELD_CLEAR_FORBIDDEN",
    });
  }

  const isScheduledSource = String(source || "").toUpperCase().includes("SCHEDULED");
  if (
    isScheduledSource &&
    isDestructiveIntent(mutationIntent) &&
    mutationIntent?.confirmDestructive !== true
  ) {
    throw new TargetingValidationError("Scheduled destructive edits require explicit confirmation", {
      code: "SCHEDULED_DESTRUCTIVE_CONFIRMATION_REQUIRED",
    });
  }

  if (
    includesNonActiveStatusFilter(normalizedFilterAst) &&
    mutationIntent?.allowNonActiveProducts !== true
  ) {
    throw new TargetingValidationError("Editing draft/archived products is not allowed for this mutation", {
      code: "NON_ACTIVE_PRODUCT_EDIT_FORBIDDEN",
    });
  }
}
