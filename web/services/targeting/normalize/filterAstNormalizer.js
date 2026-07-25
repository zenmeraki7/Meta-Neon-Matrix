import { AST_SCHEMA_VERSION, TARGET_GRANULARITIES } from "../types.js";
import { TargetingValidationError } from "../errors/TargetingValidationError.js";

function normalizeValue(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    return trimmed;
  }
  if (Array.isArray(value)) return value.map((v) => normalizeValue(v));
  return value;
}

function normalizeNode(node) {
  if (!node || typeof node !== "object") {
    throw TargetingValidationError.malformedAst("AST node must be an object");
  }
  if (node.nodeType === "group" || (!node.field && Array.isArray(node.children))) {
    return {
      nodeType: "group",
      logic: String(node.logic || "AND").trim().toUpperCase(),
      not: Boolean(node.not),
      children: (node.children || []).map(normalizeNode),
    };
  }

  return {
    nodeType: "predicate",
    field: typeof node.field === "string" ? node.field.trim() : node.field,
    operator: String(node.operator || "").trim().toUpperCase(),
    value: normalizeValue(node.value),
    not: Boolean(node.not),
  };
}

export function normalizeFilterAst(ast) {
  if (!ast || typeof ast !== "object") {
    throw TargetingValidationError.malformedAst("AST payload must be an object");
  }
  if (!ast.root) {
    throw TargetingValidationError.malformedAst("AST root is required");
  }

  const root = normalizeNode(ast.root);
  const requestedGranularity = ast?.options?.targetGranularity;
  const targetGranularity = TARGET_GRANULARITIES[requestedGranularity] || TARGET_GRANULARITIES.PRODUCT;
  return {
    version: AST_SCHEMA_VERSION,
    root,
    options: {
      targetGranularity,
    },
    context: {
      ...(ast?.context || {}),
    },
  };
}
