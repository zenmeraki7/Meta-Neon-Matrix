import { TargetingValidationError } from "../errors/TargetingValidationError.js";
import { getFieldSpecOrThrow } from "../registry/fieldRegistry.js";

function scalarExpr(path, operator, value) {
  switch (operator) {
    case "EQ":
      return { [path]: { equals: value } };
    case "NEQ":
      return {
        OR: [{ [path]: null }, { [path]: { not: value } }],
      };
    case "CONTAINS":
      return { [path]: { contains: value, mode: "insensitive" } };
    case "NOT_CONTAINS":
      return {
        OR: [{ [path]: null }, { [path]: { not: { contains: value, mode: "insensitive" } } }],
      };
    case "STARTS_WITH":
      return { [path]: { startsWith: value, mode: "insensitive" } };
    case "ENDS_WITH":
      return { [path]: { endsWith: value, mode: "insensitive" } };
    case "IN":
      return { [path]: { in: value } };
    case "NOT_IN":
      return {
        OR: [{ [path]: null }, { [path]: { notIn: value } }],
      };
    case "GT":
      return { [path]: { gt: value } };
    case "GTE":
      return { [path]: { gte: value } };
    case "LT":
      return { [path]: { lt: value } };
    case "LTE":
      return { [path]: { lte: value } };
    case "BETWEEN":
      return { [path]: { gte: value[0], lte: value[1] } };
    case "IS_EMPTY":
      return { OR: [{ [path]: null }, { [path]: "" }] };
    case "IS_NOT_EMPTY":
      return { AND: [{ [path]: { not: null } }, { [path]: { not: "" } }] };
    default:
      throw new TargetingValidationError("Operator not supported by db compiler", {
        code: "UNSUPPORTED_OPERATOR_COMPILER",
        meta: { operator },
      });
  }
}

function compileCondition(node, context = {}) {
  const fieldSpec = getFieldSpecOrThrow(node.field);
  if (fieldSpec.pathKind === "relation") {
    throw new TargetingValidationError(
      "Relation fields require relation-aware resolver path",
      {
        code: "RELATION_FIELD_REQUIRES_RESOLVER",
        meta: { field: node.field },
      },
    );
  }
  const path = fieldSpec.prismaPath;

  if (fieldSpec.valueType === "string[]") {
    if (node.operator === "IN") return { [path]: { hasSome: node.value } };
    if (node.operator === "NOT_IN") return { NOT: { [path]: { hasSome: node.value } } };
    if (node.operator === "IS_EMPTY") return { [path]: { isEmpty: true } };
    if (node.operator === "IS_NOT_EMPTY") return { [path]: { isEmpty: false } };
    if (node.operator === "EXISTS") return { [path]: { isEmpty: false } };
    if (node.operator === "NOT_EXISTS") return { [path]: { isEmpty: true } };
    throw new TargetingValidationError("Unsupported array operator", { code: "UNSUPPORTED_ARRAY_OPERATOR" });
  }

  const scalar = scalarExpr(path, node.operator, node.value);
  if (context.targetGranularity === "PRODUCT" && fieldSpec.entity === "VARIANT") {
    return { variants: { some: scalar } };
  }
  return scalar;
}

function compileNode(node, context = {}) {
  if (node.nodeType === "group") {
    const key = node.logic === "OR" ? "OR" : "AND";
    const children = node.children.map((child) => compileNode(child, context));
    const groupExpr = { [key]: children };
    return node.not ? { NOT: groupExpr } : groupExpr;
  }

  const conditionExpr = compileCondition(node, context);
  return node.not ? { NOT: conditionExpr } : conditionExpr;
}

export function compileFilterAstToPrismaWhere(ast, context = {}) {
  if (!ast || !ast.root || ast.root.nodeType !== "group") {
    throw new TargetingValidationError("Malformed AST for db compilation", {
      code: "MALFORMED_AST",
    });
  }
  return compileNode(ast.root, context);
}
