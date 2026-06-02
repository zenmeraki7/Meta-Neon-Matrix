import { TargetingValidationError } from "../errors/TargetingValidationError.js";

const LIMITS = Object.freeze({
  MAX_OR_BRANCHES: 30,
  MAX_NOT_DEPTH: 3,
  MAX_NOT_IN_VALUES: 1000,
  MAX_TOTAL_PREDICATES: 120,
});

function walk(node, state, depth = 0, notDepth = 0) {
  if (!node || typeof node !== "object") return;
  if (node.nodeType === "group") {
    const logic = String(node.logic || "").toUpperCase();
    const children = Array.isArray(node.children) ? node.children : [];
    if (logic === "OR") state.orBranches += children.length;
    const nextNotDepth = logic === "NOT" ? notDepth + 1 : notDepth;
    state.maxNotDepth = Math.max(state.maxNotDepth, nextNotDepth);
    children.forEach((child) => walk(child, state, depth + 1, nextNotDepth));
    return;
  }
  if (node.nodeType === "predicate") {
    state.predicateCount += 1;
    const field = String(node.field || "");
    const operator = String(node.operator || "").toUpperCase();
    if (operator.includes("CONTAINS") && field.toLowerCase().includes("metafield")) {
      state.metafieldWildcardContains += 1;
    }
    if (operator === "NOT_IN" && Array.isArray(node.value)) {
      state.maxNotInList = Math.max(state.maxNotInList, node.value.length);
    }
    if (operator.includes("NOT") && field.toLowerCase().includes("collection")) {
      state.negativeRelationFilters += 1;
    }
  }
}

export function assertQueryShapeGuardrails(normalizedFilterAst) {
  const state = {
    orBranches: 0,
    maxNotDepth: 0,
    maxNotInList: 0,
    predicateCount: 0,
    metafieldWildcardContains: 0,
    negativeRelationFilters: 0,
  };
  walk(normalizedFilterAst?.root, state, 0, 0);

  const tooExpensive =
    state.orBranches > LIMITS.MAX_OR_BRANCHES ||
    state.maxNotDepth > LIMITS.MAX_NOT_DEPTH ||
    state.maxNotInList > LIMITS.MAX_NOT_IN_VALUES ||
    state.predicateCount > LIMITS.MAX_TOTAL_PREDICATES ||
    state.metafieldWildcardContains > 0;

  if (tooExpensive) {
    throw new TargetingValidationError(
      "This filter is too expensive. Add a more selective condition.",
      {
        code: "TARGETING_QUERY_TOO_EXPENSIVE",
        meta: state,
      },
    );
  }

  return state;
}

