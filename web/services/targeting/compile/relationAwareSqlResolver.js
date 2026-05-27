import { getFieldSpecOrThrow } from "../registry/fieldRegistry.js";
import { TargetingValidationError } from "../errors/TargetingValidationError.js";

const RELATION_FIELD_OPERATOR_MATRIX = Object.freeze({
  collections: Object.freeze({
    allowedOperators: new Set(["IN", "NOT_IN", "EXISTS", "NOT_EXISTS"]),
    indexedOperators: new Set(["IN", "NOT_IN", "EXISTS", "NOT_EXISTS"]),
    valueKindByOperator: Object.freeze({
      IN: "string_array_non_empty",
      NOT_IN: "string_array_non_empty",
      EXISTS: "none",
      NOT_EXISTS: "none",
    }),
  }),
  productMetafield: Object.freeze({
    allowedOperators: new Set(["EQ", "NEQ", "CONTAINS", "NOT_CONTAINS", "EXISTS", "NOT_EXISTS", "IS_EMPTY", "IS_NOT_EMPTY"]),
    indexedOperators: new Set(["EQ", "NEQ", "CONTAINS", "NOT_CONTAINS", "EXISTS", "NOT_EXISTS", "IS_EMPTY", "IS_NOT_EMPTY"]),
    valueKindByOperator: Object.freeze({
      EQ: "string_scalar_non_empty",
      NEQ: "string_scalar_non_empty",
      CONTAINS: "string_scalar_non_empty",
      NOT_CONTAINS: "string_scalar_non_empty",
      EXISTS: "none",
      NOT_EXISTS: "none",
      IS_EMPTY: "none",
      IS_NOT_EMPTY: "none",
    }),
  }),
  variantMetafield: Object.freeze({
    allowedOperators: new Set(["EQ", "NEQ", "CONTAINS", "NOT_CONTAINS", "EXISTS", "NOT_EXISTS", "IS_EMPTY", "IS_NOT_EMPTY"]),
    indexedOperators: new Set(["EQ", "NEQ", "CONTAINS", "NOT_CONTAINS", "EXISTS", "NOT_EXISTS", "IS_EMPTY", "IS_NOT_EMPTY"]),
    valueKindByOperator: Object.freeze({
      EQ: "string_scalar_non_empty",
      NEQ: "string_scalar_non_empty",
      CONTAINS: "string_scalar_non_empty",
      NOT_CONTAINS: "string_scalar_non_empty",
      EXISTS: "none",
      NOT_EXISTS: "none",
      IS_EMPTY: "none",
      IS_NOT_EMPTY: "none",
    }),
  }),
});

function pushParam(params, value) {
  params.push(value);
  return `$${params.length}`;
}

function fail(message, code, meta = {}) {
  throw new TargetingValidationError(message, {
    code,
    meta,
  });
}

function coerceStringStrict(value, {
  field,
  operator,
  allowEmpty = false,
} = {}) {
  if (typeof value !== "string") {
    fail("Relation value type is invalid", "RELATION_VALUE_TYPE_INVALID", {
      field,
      operator,
      expected: "string",
      actual: Array.isArray(value) ? "array" : typeof value,
    });
  }
  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length === 0) {
    fail("Relation value must not be empty", "RELATION_VALUE_EMPTY", {
      field,
      operator,
    });
  }
  return trimmed;
}

function coerceStringArrayStrict(value, { field, operator } = {}) {
  if (!Array.isArray(value)) {
    fail("Relation operator requires array value", "RELATION_OPERATOR_REQUIRES_ARRAY", {
      field,
      operator,
    });
  }
  if (!value.length) {
    fail("Relation value array must not be empty", "RELATION_VALUE_EMPTY", {
      field,
      operator,
    });
  }
  const out = value.map((entry) => coerceStringStrict(entry, {
    field,
    operator,
    allowEmpty: false,
  }));
  if (!out.length) {
    fail("Relation value array must not be empty", "RELATION_VALUE_EMPTY", {
      field,
      operator,
    });
  }
  return out;
}

function validateRelationPredicateCompatibility(predicate) {
  const field = String(predicate?.field || "");
  const operator = String(predicate?.operator || "").toUpperCase();
  const entry = RELATION_FIELD_OPERATOR_MATRIX[field];

  if (!entry) {
    fail("Relation field is unsupported", "RELATION_FIELD_UNSUPPORTED", { field, operator });
  }
  if (!entry.allowedOperators.has(operator)) {
    fail("Relation operator is unsupported", "RELATION_OPERATOR_UNSUPPORTED", { field, operator });
  }
  if (!entry.indexedOperators.has(operator)) {
    fail("Relation field is not indexed for operator", "RELATION_FIELD_NOT_INDEXED_FOR_OPERATOR", {
      field,
      operator,
    });
  }

  const valueKind = entry.valueKindByOperator[operator];
  if (valueKind === "none") {
    return { field, operator, value: null };
  }
  if (valueKind === "string_array_non_empty") {
    return { field, operator, value: coerceStringArrayStrict(predicate?.value, { field, operator }) };
  }
  if (valueKind === "string_scalar_non_empty") {
    return { field, operator, value: coerceStringStrict(predicate?.value, { field, operator }) };
  }
  fail("Relation value type is invalid", "RELATION_VALUE_TYPE_INVALID", { field, operator, valueKind });
}

function scalarExpr(alias, column, operator, value, params) {
  const col = `${alias}."${column}"`;
  switch (operator) {
    case "EQ": return `${col} = ${pushParam(params, value)}`;
    case "NEQ": return `(${col} IS NULL OR ${col} <> ${pushParam(params, value)})`;
    case "CONTAINS": return `${col} ILIKE ${pushParam(params, `%${value}%`)}`;
    case "NOT_CONTAINS": return `(${col} IS NULL OR ${col} NOT ILIKE ${pushParam(params, `%${value}%`)})`;
    case "STARTS_WITH": return `${col} ILIKE ${pushParam(params, `${value}%`)}`;
    case "ENDS_WITH": return `${col} ILIKE ${pushParam(params, `%${value}`)}`;
    case "IN": return `${col} = ANY(${pushParam(params, value)})`;
    case "NOT_IN": return `(${col} IS NULL OR NOT (${col} = ANY(${pushParam(params, value)})))`;
    case "GT": return `${col} > ${pushParam(params, value)}`;
    case "GTE": return `${col} >= ${pushParam(params, value)}`;
    case "LT": return `${col} < ${pushParam(params, value)}`;
    case "LTE": return `${col} <= ${pushParam(params, value)}`;
    case "BETWEEN": return `${col} BETWEEN ${pushParam(params, value[0])} AND ${pushParam(params, value[1])}`;
    case "IS_EMPTY": return `(${col} IS NULL OR ${col} = '')`;
    case "IS_NOT_EMPTY": return `(${col} IS NOT NULL AND ${col} <> '')`;
    case "EXISTS": return `${col} IS NOT NULL`;
    case "NOT_EXISTS": return `${col} IS NULL`;
    default:
      throw new TargetingValidationError("Unsupported operator in relation-aware SQL resolver", {
        code: "UNSUPPORTED_OPERATOR_SQL",
        meta: { operator },
      });
  }
}

function buildCollectionsExpr({ targetType, operator, value, params }) {
  const compatibility = validateRelationPredicateCompatibility({
    field: "collections",
    operator,
    value,
  });
  const normalizedOperator = compatibility.operator;
  const values = compatibility.value || [];
  const bind = values.length ? pushParam(params, values) : null;
  const targetProductExpr = targetType === "VARIANT" ? `v."productId"` : `p."id"`;
  const existsSql = `
    EXISTS (
      SELECT 1
      FROM "ProductCollection" pc
      WHERE pc."shop" = $1
        AND pc."mirrorBatchId" = $2
        AND pc."productId" = ${targetProductExpr}
        ${bind ? `AND pc."collectionId" = ANY(${bind})` : ""}
    )
  `;
  if (normalizedOperator === "IN") return existsSql;
  if (normalizedOperator === "NOT_IN") return `(NOT ${existsSql})`;
  if (normalizedOperator === "EXISTS") {
    return `
      EXISTS (
        SELECT 1 FROM "ProductCollection" pc
        WHERE pc."shop" = $1
          AND pc."mirrorBatchId" = $2
          AND pc."productId" = ${targetProductExpr}
      )
    `;
  }
  if (normalizedOperator === "NOT_EXISTS") {
    return `
      NOT EXISTS (
        SELECT 1 FROM "ProductCollection" pc
        WHERE pc."shop" = $1
          AND pc."mirrorBatchId" = $2
          AND pc."productId" = ${targetProductExpr}
      )
    `;
  }
  throw new TargetingValidationError("Unsupported collections operator", {
    code: "UNSUPPORTED_RELATION_OPERATOR",
    meta: { field: "collections", operator },
  });
}

function buildMetafieldExpr({ targetType, variantScoped, operator, value, meta, params }) {
  const relationField = variantScoped ? "variantMetafield" : "productMetafield";
  const compatibility = validateRelationPredicateCompatibility({
    field: relationField,
    operator,
    value,
  });
  const normalizedOperator = compatibility.operator;
  const namespace = String(meta?.namespace || "").trim();
  const key = String(meta?.key || "").trim();
  if (!namespace || !key) {
    fail("Metafield namespace/key is required", "RELATION_VALUE_TYPE_INVALID", {
      field: relationField,
      operator: normalizedOperator,
      expectedMeta: ["namespace", "key"],
    });
  }
  const ownerType = variantScoped ? "VARIANT" : "PRODUCT";
  const ownerIdExpr = variantScoped
    ? (targetType === "VARIANT" ? `v."id"` : `vx."id"`)
    : (targetType === "VARIANT" ? `v."productId"` : `p."id"`);
  const ownerJoin = variantScoped && targetType === "PRODUCT"
    ? `INNER JOIN "Variant" vx ON vx."shop" = p."shop" AND vx."mirrorBatchId" = p."mirrorBatchId" AND vx."productId" = p."id"`
    : "";

  const base = `
    SELECT 1
    FROM "MetafieldMirror" m
    ${ownerJoin}
    WHERE m."shop" = $1
      AND m."mirrorBatchId" = $2
      AND m."ownerType" = '${ownerType}'
      AND m."ownerId" = ${ownerIdExpr}
      AND m."namespace" = ${pushParam(params, namespace)}
      AND m."key" = ${pushParam(params, key)}
  `;
  const valueSql = (() => {
    if (normalizedOperator === "EXISTS") return "1=1";
    if (normalizedOperator === "NOT_EXISTS") return "1=1";
    if (normalizedOperator === "IS_EMPTY") return `(m."valueTextNormalized" IS NULL OR m."valueTextNormalized" = '')`;
    if (normalizedOperator === "IS_NOT_EMPTY") return `(m."valueTextNormalized" IS NOT NULL AND m."valueTextNormalized" <> '')`;
    const valueText = String(compatibility.value || "").toLowerCase();
    if (normalizedOperator === "EQ") return `m."valueTextNormalized" = ${pushParam(params, valueText)}`;
    if (normalizedOperator === "NEQ") return `m."valueTextNormalized" <> ${pushParam(params, valueText)}`;
    if (normalizedOperator === "CONTAINS") return `m."valueTextNormalized" LIKE ${pushParam(params, `%${valueText}%`)}`;
    if (normalizedOperator === "NOT_CONTAINS") return `m."valueTextNormalized" NOT LIKE ${pushParam(params, `%${valueText}%`)}`;
    throw new TargetingValidationError("Unsupported metafield operator", {
      code: "RELATION_OPERATOR_UNSUPPORTED",
      meta: { field: relationField, operator: normalizedOperator },
    });
  })();
  const existsSql = `EXISTS (${base} AND ${valueSql})`;
  if (normalizedOperator === "NOT_EXISTS") return `(NOT EXISTS (${base}))`;
  return existsSql;
}

function compilePredicate(node, context, params) {
  const spec = getFieldSpecOrThrow(node.field);
  if (spec.pathKind === "relation") {
    if (node.field === "collections") {
      return buildCollectionsExpr({
        targetType: context.targetType,
        operator: node.operator,
        value: node.value,
        params,
      });
    }
    if (node.field === "productMetafield" || node.field === "variantMetafield") {
      return buildMetafieldExpr({
        targetType: context.targetType,
        variantScoped: node.field === "variantMetafield",
        operator: node.operator,
        value: node.value,
        meta: node.meta || {},
        params,
      });
    }
    throw new TargetingValidationError("Unsupported relation field", {
      code: "UNSUPPORTED_RELATION_FIELD",
      meta: { field: node.field },
    });
  }

  const isVariantField = spec.model === "Variant";
  const isProductField = spec.model === "Product";
  if (context.targetType === "PRODUCT" && isVariantField) {
    const vxExpr = scalarExpr("vx", spec.column, node.operator, node.value, params);
    return `
      EXISTS (
        SELECT 1 FROM "Variant" vx
        WHERE vx."shop" = p."shop"
          AND vx."mirrorBatchId" = p."mirrorBatchId"
          AND vx."productId" = p."id"
          AND ${vxExpr}
      )
    `;
  }

  const alias = context.targetType === "VARIANT"
    ? (isProductField ? "p" : "v")
    : "p";
  return scalarExpr(alias, spec.column, node.operator, node.value, params);
}

function compileNode(node, context, params) {
  if (node.nodeType === "group") {
    const op = node.logic === "OR" ? " OR " : " AND ";
    const sql = `(${node.children.map((c) => compileNode(c, context, params)).join(op)})`;
    return node.not ? `(NOT ${sql})` : sql;
  }
  const sql = compilePredicate(node, context, params);
  return node.not ? `(NOT ${sql})` : sql;
}

export function compileRelationAwareAstWhereSql(ast, context = {}) {
  const params = [String(context.shop), String(context.mirrorBatchId)];
  const whereSql = compileNode(ast?.root, context, params);
  return { whereSql, params };
}
