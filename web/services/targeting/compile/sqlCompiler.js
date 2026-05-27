import { TargetingValidationError } from "../errors/TargetingValidationError.js";
import { getFieldSpecOrThrow } from "../registry/fieldRegistry.js";

function pushParam(params, value) {
  params.push(value);
  return `$${params.length}`;
}

function compileConditionSql(node, params) {
  const fieldSpec = getFieldSpecOrThrow(node.field);
  if (fieldSpec.pathKind === "relation") {
    throw new TargetingValidationError(
      "Relation fields require canonical relation-aware resolver path",
      {
        code: "RELATION_FIELD_REQUIRES_RESOLVER",
        meta: { field: node.field },
      },
    );
  }
  const { prismaPath } = fieldSpec;
  const col = `"${prismaPath}"`;

  switch (node.operator) {
    case "EQ": return `${col} = ${pushParam(params, node.value)}`;
    case "NEQ": return `(${col} IS NULL OR ${col} <> ${pushParam(params, node.value)})`;
    case "CONTAINS": return `${col} ILIKE ${pushParam(params, `%${node.value}%`)}`;
    case "NOT_CONTAINS": return `${col} NOT ILIKE ${pushParam(params, `%${node.value}%`)}`;
    case "STARTS_WITH": return `${col} ILIKE ${pushParam(params, `${node.value}%`)}`;
    case "ENDS_WITH": return `${col} ILIKE ${pushParam(params, `%${node.value}`)}`;
    case "IN": return `${col} = ANY(${pushParam(params, node.value)})`;
    case "NOT_IN": return `(${col} IS NULL OR NOT (${col} = ANY(${pushParam(params, node.value)})))`;
    case "GT": return `${col} > ${pushParam(params, node.value)}`;
    case "GTE": return `${col} >= ${pushParam(params, node.value)}`;
    case "LT": return `${col} < ${pushParam(params, node.value)}`;
    case "LTE": return `${col} <= ${pushParam(params, node.value)}`;
    case "BETWEEN": return `${col} BETWEEN ${pushParam(params, node.value[0])} AND ${pushParam(params, node.value[1])}`;
    case "IS_EMPTY": return `(${col} IS NULL OR ${col} = '')`;
    case "IS_NOT_EMPTY": return `(${col} IS NOT NULL AND ${col} <> '')`;
    case "EXISTS": return `${col} IS NOT NULL`;
    case "NOT_EXISTS": return `${col} IS NULL`;
    default:
      throw new TargetingValidationError("Unsupported SQL operator", {
        code: "UNSUPPORTED_OPERATOR_SQL",
        meta: { operator: node.operator },
      });
  }
}

function compileNodeSql(node, params) {
  if (node.nodeType === "group") {
    const op = node.logic === "OR" ? " OR " : " AND ";
    const sql = `(${node.children.map((child) => compileNodeSql(child, params)).join(op)})`;
    return node.not ? `(NOT ${sql})` : sql;
  }

  const sql = compileConditionSql(node, params);
  return node.not ? `(NOT ${sql})` : sql;
}

export function compileFilterAstToSql(ast) {
  if (!ast || !ast.root || ast.root.nodeType !== "group") {
    throw new TargetingValidationError("Malformed AST for SQL compilation", {
      code: "MALFORMED_AST",
    });
  }
  const params = [];
  const whereSql = compileNodeSql(ast.root, params);
  return { whereSql, params };
}
