import { TargetingValidationError } from "../errors/TargetingValidationError.js";

function op(spec) {
  return Object.freeze(spec);
}

// semantics documents query intent; compile layer enforces concrete SQL/Prisma behavior.
export const operatorRegistry = Object.freeze({
  EQ: op({
    key: "EQ",
    arity: "single",
    valueTypes: ["string", "number", "boolean", "date"],
    negative: false,
    semantics: "equals",
  }),
  NEQ: op({
    key: "NEQ",
    arity: "single",
    valueTypes: ["string", "number", "boolean", "date"],
    negative: true,
    semantics: "not equals with null-aware behavior: (value IS NULL OR value <> input)",
  }),
  CONTAINS: op({
    key: "CONTAINS",
    arity: "single",
    valueTypes: ["string"],
    negative: false,
    semantics: "ILIKE %value% for scalar strings; relation contains for relation fields",
  }),
  NOT_CONTAINS: op({
    key: "NOT_CONTAINS",
    arity: "single",
    valueTypes: ["string"],
    negative: true,
    semantics: "NOT ILIKE for scalar strings; anti-join semantics for relation fields",
  }),
  STARTS_WITH: op({
    key: "STARTS_WITH",
    arity: "single",
    valueTypes: ["string"],
    negative: false,
    semantics: "prefix match",
  }),
  ENDS_WITH: op({
    key: "ENDS_WITH",
    arity: "single",
    valueTypes: ["string"],
    negative: false,
    semantics: "suffix match",
  }),
  LT: op({
    key: "LT",
    arity: "single",
    valueTypes: ["number", "date"],
    negative: false,
    semantics: "less than",
  }),
  LTE: op({
    key: "LTE",
    arity: "single",
    valueTypes: ["number", "date"],
    negative: false,
    semantics: "less than or equal",
  }),
  GT: op({
    key: "GT",
    arity: "single",
    valueTypes: ["number", "date"],
    negative: false,
    semantics: "greater than",
  }),
  GTE: op({
    key: "GTE",
    arity: "single",
    valueTypes: ["number", "date"],
    negative: false,
    semantics: "greater than or equal",
  }),
  IN: op({
    key: "IN",
    arity: "array",
    valueTypes: ["string", "number", "boolean", "date"],
    negative: false,
    semantics: "in set",
  }),
  NOT_IN: op({
    key: "NOT_IN",
    arity: "array",
    valueTypes: ["string", "number", "boolean", "date"],
    negative: true,
    semantics: "not in set with null-aware behavior: (value IS NULL OR value NOT IN (...))",
  }),
  IS_EMPTY: op({
    key: "IS_EMPTY",
    arity: "none",
    valueTypes: [],
    negative: false,
    semantics: "null/blank/empty array/NOT EXISTS by field kind",
  }),
  IS_NOT_EMPTY: op({
    key: "IS_NOT_EMPTY",
    arity: "none",
    valueTypes: [],
    negative: true,
    semantics: "not empty by field kind",
  }),
  BETWEEN: op({
    key: "BETWEEN",
    arity: "range",
    valueTypes: ["number", "date"],
    negative: false,
    semantics: "inclusive range",
  }),
  EXISTS: op({
    key: "EXISTS",
    arity: "none",
    valueTypes: [],
    negative: false,
    semantics: "strict relation/metafield existence",
  }),
  NOT_EXISTS: op({
    key: "NOT_EXISTS",
    arity: "none",
    valueTypes: [],
    negative: true,
    semantics: "strict relation/metafield absence",
  }),
});

export function getOperatorSpecOrThrow(operator) {
  const spec = operatorRegistry[operator];
  if (!spec) {
    throw new TargetingValidationError("Unknown filter operator", {
      code: "UNKNOWN_OPERATOR",
      meta: { operator },
    });
  }
  return spec;
}

export function applyGroupNot(logic, clauses) {
  // Explicit De Morgan transform helper for any future AST rewrite path.
  // NOT(AND[a,b]) -> OR[NOT a, NOT b], NOT(OR[a,b]) -> AND[NOT a, NOT b]
  const nextLogic = logic === "AND" ? "OR" : "AND";
  return {
    logic: nextLogic,
    clauses: clauses.map((clause) => ({ NOT: clause })),
  };
}
