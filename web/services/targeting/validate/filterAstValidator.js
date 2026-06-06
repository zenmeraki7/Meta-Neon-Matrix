import { TargetingValidationError } from "../errors/TargetingValidationError.js";
import { FILTER_GROUP_LOGICS } from "../types.js";
import { getFieldSpecOrThrow } from "../registry/fieldRegistry.js";
import { getOperatorSpecOrThrow } from "../registry/operatorRegistry.js";

const MAX_DEPTH = 6;
const MAX_CONDITIONS = 100;
const SUPPORTED_CONTEXT_SOURCES = new Set([
  "MANUAL_PREVIEW",
  "PRODUCT_LISTING",
  "MANUAL_EXECUTE",
  "SCHEDULED_EDIT",
  "RECURRING_EDIT",
  "EXPORT",
  "AUTOMATIC_RULE",
  "LEGACY_FILTER_PARAMS",
]);

function inferValueType(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (value instanceof Date) return "date";
  return "object";
}

function isValueCompatible(fieldType, operatorType, value) {
  if (operatorType === "none") return true;

  const scalar = Array.isArray(value) ? value[0] : value;
  const inferred = inferValueType(scalar);

  if (fieldType === "string[]") {
    return inferred === "string";
  }
  if (fieldType === "date") {
    return inferred === "date" || inferred === "string";
  }
  return fieldType === inferred;
}

function assertValueByArity(operatorSpec, node, path) {
  if (operatorSpec.arity === "none" && node.value !== undefined && node.value !== null) {
    throw new TargetingValidationError("Operator does not support value", { code: "UNEXPECTED_VALUE", path });
  }
  if (operatorSpec.arity === "single" && (node.value === undefined || node.value === null)) {
    throw new TargetingValidationError("Operator requires value", { code: "MISSING_VALUE", path });
  }
  if (operatorSpec.arity === "array" && !Array.isArray(node.value)) {
    throw new TargetingValidationError("Operator requires array value", { code: "INVALID_VALUE_TYPE", path });
  }
  if (operatorSpec.arity === "range" && (!Array.isArray(node.value) || node.value.length !== 2)) {
    throw new TargetingValidationError("Operator requires [from,to] array", { code: "INVALID_RANGE", path });
  }
}

function validateCondition(node, path, context) {
  const fieldSpec = getFieldSpecOrThrow(node.field);
  const operatorSpec = getOperatorSpecOrThrow(node.operator);

  if (!fieldSpec.operators.includes(node.operator)) {
    throw new TargetingValidationError("Operator not allowed for field", {
      code: "UNSUPPORTED_FIELD_OPERATOR",
      path,
      meta: { field: node.field, operator: node.operator },
    });
  }

  if (!fieldSpec.allowedGranularities.includes(context.targetGranularity)) {
    throw new TargetingValidationError("Field not allowed for target granularity", {
      code: "UNSUPPORTED_GRANULARITY",
      path,
      meta: { field: node.field, targetGranularity: context.targetGranularity },
    });
  }

  assertValueByArity(operatorSpec, node, path);

  if (!operatorSpec.valueTypes.length) return;
  if (!operatorSpec.valueTypes.includes(fieldSpec.valueType) && fieldSpec.valueType !== "string[]") {
    throw new TargetingValidationError("Invalid field/operator type combination", {
      code: "INVALID_FIELD_OPERATOR_TYPE_COMBO",
      path,
      meta: {
        field: node.field,
        fieldType: fieldSpec.valueType,
        operator: node.operator,
      },
    });
  }

  if (!isValueCompatible(fieldSpec.valueType, operatorSpec.arity, node.value)) {
    throw new TargetingValidationError("Invalid value type for field/operator", {
      code: "INVALID_VALUE_TYPE",
      path,
      meta: {
        field: node.field,
        fieldType: fieldSpec.valueType,
        operator: node.operator,
        valueType: inferValueType(node.value),
      },
    });
  }
}

function walk(node, path, depth, state, context) {
  if (depth > MAX_DEPTH) {
    throw new TargetingValidationError("Filter nesting depth exceeded", { code: "MAX_DEPTH_EXCEEDED", path });
  }

  if (node.nodeType === "group") {
    if (!FILTER_GROUP_LOGICS.includes(node.logic)) {
      throw new TargetingValidationError("Invalid group logic", { code: "INVALID_LOGIC", path });
    }
    if (!Array.isArray(node.children) || node.children.length === 0) {
      throw new TargetingValidationError("Empty filter group", { code: "EMPTY_GROUP", path });
    }
    node.children.forEach((child, idx) => walk(child, `${path}.children[${idx}]`, depth + 1, state, context));
    return;
  }

  if (node.nodeType !== "predicate") {
    throw new TargetingValidationError("Invalid node type", { code: "INVALID_NODE_TYPE", path });
  }

  state.conditionCount += 1;
  if (state.conditionCount > MAX_CONDITIONS) {
    throw new TargetingValidationError("Too many conditions", { code: "MAX_CONDITIONS_EXCEEDED", path });
  }
  validateCondition(node, path, context);
}

export function validateFilterAstOrThrow(ast, context = {}) {
  const targetGranularity = context.targetGranularity || ast?.options?.targetGranularity || "PRODUCT";
  const source = context.source || ast?.context?.source || null;
  if (!ast || !ast.root || ast.root.nodeType !== "group") {
    throw new TargetingValidationError("Filter root must be a GROUP", { code: "INVALID_ROOT" });
  }
  if (source && !SUPPORTED_CONTEXT_SOURCES.has(source)) {
    throw TargetingValidationError.unsupportedContext({ meta: { source } });
  }

  walk(ast.root, "root", 1, { conditionCount: 0 }, { targetGranularity });
  return true;
}
