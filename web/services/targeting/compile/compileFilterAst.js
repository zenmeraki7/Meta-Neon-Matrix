import { compileFilterAstToPrismaWhere } from "./prismaCompiler.js";
import { compileFilterAstToSql } from "./sqlCompiler.js";
import { validateFilterAstOrThrow } from "../validate/filterAstValidator.js";
import { TargetingValidationError } from "../errors/TargetingValidationError.js";
import { getFieldSpecOrThrow } from "../registry/fieldRegistry.js";

function collectPredicateFields(node, acc = []) {
  if (node.nodeType === "group") {
    node.children.forEach((child) => collectPredicateFields(child, acc));
    return acc;
  }
  acc.push(node.field);
  return acc;
}

function inferTargetModel(ast, targetGranularity) {
  if (!ast?.root) {
    throw TargetingValidationError.malformedAst("AST root is required for target model inference");
  }

  if (targetGranularity === "VARIANT") return "Variant";
  if (targetGranularity === "PRODUCT_WITH_MATCHING_VARIANTS") return "Product";
  if (targetGranularity === "PRODUCT") return "Product";

  const fields = collectPredicateFields(ast.root);
  if (!fields.length) {
    throw new TargetingValidationError("AST must contain at least one predicate", {
      code: "EMPTY_PREDICATE_SET",
    });
  }

  const hasVariantField = fields.some((field) => getFieldSpecOrThrow(field).model === "Variant");
  return hasVariantField ? "Variant" : "Product";
}

function buildOrderBy(targetModel) {
  if (targetModel === "Variant") return [{ id: "asc" }];
  return [{ id: "asc" }];
}

export function compileFilterAst(ast, options = {}) {
  const dialect = options.dialect || "db";
  const context = options.context || {};
  const targetGranularity = context.targetGranularity || ast?.options?.targetGranularity || "PRODUCT";
  if (!ast || typeof ast !== "object") {
    throw TargetingValidationError.malformedAst("AST must be an object");
  }

  validateFilterAstOrThrow(ast, {
    targetGranularity,
    source: context.source,
  });

  const targetModel = inferTargetModel(ast, targetGranularity);
  const orderBy = buildOrderBy(targetModel);

  if (dialect === "db") {
    const where = compileFilterAstToPrismaWhere(ast, {
      ...context,
      targetGranularity,
      targetModel,
    });
    return {
      where,
      sql: null,
      targetModel,
      targetGranularity,
      orderBy,
    };
  }

  if (dialect === "sql") {
    const compiled = compileFilterAstToSql(ast);
    return {
      where: null,
      sql: {
        text: compiled.whereSql,
        params: compiled.params,
      },
      targetModel,
      targetGranularity,
      orderBy,
    };
  }

  throw new TargetingValidationError("Unsupported compile dialect", {
    code: "UNSUPPORTED_COMPILE_DIALECT",
    meta: { dialect },
  });
}
