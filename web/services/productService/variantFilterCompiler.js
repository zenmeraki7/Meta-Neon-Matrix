import { Prisma } from "../../repositories/prismaTypes.js";

const deprecationWarnings = new Set();
function warnDeprecatedOnce(key, message) {
  if (deprecationWarnings.has(key)) return;
  deprecationWarnings.add(key);
  console.warn(`[DEPRECATED] ${message}`);
}

function normalizeOperator(operator) {
  return String(operator || "equals").trim().toLowerCase();
}

function normalizeText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function decimalValue(value) {
  if (value === null || value === undefined || value === "") return null;

  try {
    return new db.Decimal(String(value));
  } catch (_error) {
    return null;
  }
}

function intValue(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function boolValue(value) {
  const normalized = normalizeLower(value);

  if (["true", "yes", "1", "enabled", "active"].includes(normalized)) return true;
  if (["false", "no", "0", "disabled", "inactive"].includes(normalized)) return false;

  return null;
}

function compileTextFilter(field, operator, value) {
  const op = normalizeOperator(operator);
  const text = normalizeText(value);

  if (op === "is empty" || op === "is empty/blank") {
    return {
      OR: [
        { [field]: null },
        { [field]: "" },
      ],
    };
  }

  if (op === "is not empty") {
    return {
      AND: [
        { [field]: { not: null } },
        { [field]: { not: "" } },
      ],
    };
  }

  if (op === "contains") {
    return {
      [field]: {
        contains: text,
        mode: "insensitive",
      },
    };
  }

  if (op === "does not contain") {
    return {
      OR: [
        { [field]: null },
        {
          [field]: {
            not: {
              contains: text,
              mode: "insensitive",
            },
          },
        },
      ],
    };
  }

  if (op === "starts with") {
    return {
      [field]: {
        startsWith: text,
        mode: "insensitive",
      },
    };
  }

  if (op === "ends with") {
    return {
      [field]: {
        endsWith: text,
        mode: "insensitive",
      },
    };
  }

  if (op === "is not" || op === "not equals" || op === "!=") {
    return {
      OR: [
        { [field]: null },
        {
          [field]: {
            not: text,
            mode: "insensitive",
          },
        },
      ],
    };
  }

  return {
    [field]: {
      equals: text,
      mode: "insensitive",
    },
  };
}

function compileDecimalFilter(field, operator, value) {
  const op = normalizeOperator(operator);
  const decimal = decimalValue(value);

  if (op === "is empty" || op === "is empty/blank") {
    return { [field]: null };
  }

  if (op === "is not empty") {
    return { [field]: { not: null } };
  }

  if (!decimal) {
    throw new Error(`Invalid decimal value for ${field}: ${value}`);
  }

  if (op === ">" || op === "greater than") {
    return { [field]: { gt: decimal } };
  }

  if (op === ">=" || op === "greater than or equal") {
    return { [field]: { gte: decimal } };
  }

  if (op === "<" || op === "less than") {
    return { [field]: { lt: decimal } };
  }

  if (op === "<=" || op === "less than or equal") {
    return { [field]: { lte: decimal } };
  }

  if (op === "is not" || op === "not equals" || op === "!=") {
    return { [field]: { not: decimal } };
  }

  return { [field]: decimal };
}

function compileIntFilter(field, operator, value) {
  const op = normalizeOperator(operator);
  const parsed = intValue(value);

  if (op === "is empty" || op === "is empty/blank") {
    return { [field]: null };
  }

  if (op === "is not empty") {
    return { [field]: { not: null } };
  }

  if (parsed === null) {
    throw new Error(`Invalid integer value for ${field}: ${value}`);
  }

  if (op === ">" || op === "greater than") {
    return { [field]: { gt: parsed } };
  }

  if (op === ">=" || op === "greater than or equal") {
    return { [field]: { gte: parsed } };
  }

  if (op === "<" || op === "less than") {
    return { [field]: { lt: parsed } };
  }

  if (op === "<=" || op === "less than or equal") {
    return { [field]: { lte: parsed } };
  }

  if (op === "is not" || op === "not equals" || op === "!=") {
    return { [field]: { not: parsed } };
  }

  return { [field]: parsed };
}

function compileBooleanFilter(field, operator, value) {
  const op = normalizeOperator(operator);

  if (op === "is empty" || op === "is empty/blank") {
    return { [field]: null };
  }

  if (op === "is not empty") {
    return { [field]: { not: null } };
  }

  const parsed = boolValue(value);
  if (parsed === null) {
    throw new Error(`Invalid boolean value for ${field}: ${value}`);
  }

  if (op === "is not" || op === "not equals" || op === "!=") {
    return { [field]: { not: parsed } };
  }

  return { [field]: parsed };
}

function compileOptionNameValueFilter(optionName, operator, optionValue) {
  const normalizedOptionName = normalizeText(optionName);
  if (!normalizedOptionName) {
    throw new Error("optionName is required for option filter compilation");
  }

  return {
    OR: [
      {
        AND: [
          compileTextFilter("option1Value", operator, optionValue),
          {
            product: {
              option1Name: {
                equals: normalizedOptionName,
                mode: "insensitive",
              },
            },
          },
        ],
      },
      {
        AND: [
          compileTextFilter("option2Value", operator, optionValue),
          {
            product: {
              option2Name: {
                equals: normalizedOptionName,
                mode: "insensitive",
              },
            },
          },
        ],
      },
      {
        AND: [
          compileTextFilter("option3Value", operator, optionValue),
          {
            product: {
              option3Name: {
                equals: normalizedOptionName,
                mode: "insensitive",
              },
            },
          },
        ],
      },
    ],
  };
}

const VARIANT_FIELD_MAP = Object.freeze({
  sku: {
    prismaField: "sku",
    type: "text",
  },
  variantSku: {
    prismaField: "sku",
    type: "text",
  },
  barcode: {
    prismaField: "barcode",
    type: "text",
  },
  variantBarcode: {
    prismaField: "barcode",
    type: "text",
  },
  price: {
    prismaField: "price",
    type: "decimal",
  },
  variantPrice: {
    prismaField: "price",
    type: "decimal",
  },
  compareAtPrice: {
    prismaField: "compareAtPrice",
    type: "decimal",
  },
  cost: {
    prismaField: "cost",
    type: "decimal",
  },
  inventoryQuantity: {
    prismaField: "inventoryQuantity",
    type: "int",
  },
  inventoryPolicy: {
    prismaField: "inventoryPolicy",
    type: "text",
  },
  taxable: {
    prismaField: "taxable",
    type: "boolean",
  },
  tracked: {
    prismaField: "tracked",
    type: "boolean",
  },
  physicalProduct: {
    prismaField: "physicalProduct",
    type: "boolean",
  },
  option1Value: {
    prismaField: "option1Value",
    type: "text",
  },
  option2Value: {
    prismaField: "option2Value",
    type: "text",
  },
  option3Value: {
    prismaField: "option3Value",
    type: "text",
  },
  weight: {
    prismaField: "weight",
    type: "decimal",
  },
  weightUnit: {
    prismaField: "weightUnit",
    type: "text",
  },
  countryOfOrigin: {
    prismaField: "countryOfOrigin",
    type: "text",
  },
  hsTariffCode: {
    prismaField: "hsTariffCode",
    type: "text",
  },
});

function getFilterField(filter) {
  return (
    filter?.field ||
    filter?.key ||
    filter?.name ||
    filter?.column ||
    filter?.type ||
    ""
  );
}

function getFilterOperator(filter) {
  return (
    filter?.operator ||
    filter?.condition ||
    filter?.op ||
    "equals"
  );
}

function getFilterValue(filter) {
  if (Object.prototype.hasOwnProperty.call(filter || {}, "value")) {
    return filter.value;
  }

  if (Object.prototype.hasOwnProperty.call(filter || {}, "supportValue")) {
    return filter.supportValue;
  }

  if (Object.prototype.hasOwnProperty.call(filter || {}, "searchKey")) {
    return filter.searchKey;
  }

  return "";
}

export function compileVariantPrismaWhere(rawFilterInput = [], shop, mirrorBatchId) {
  // @deprecated Use TargetingEngineService.resolvePreviewTargets/resolveAndFreeze* APIs.
  warnDeprecatedOnce(
    "compileVariantPrismaWhere",
    "compileVariantPrismaWhere direct usage is deprecated. Migrate to TargetingEngineService.",
  );
  if (!shop) throw new Error("shop is required for variant filter compilation");
  if (!mirrorBatchId) throw new Error("mirrorBatchId is required for variant filter compilation");

  const clauses = [{ shop }, { mirrorBatchId }];

  for (const filter of rawFilterInput || []) {
    const rawField = getFilterField(filter);
    const fieldKey = String(rawField || "").trim();
    if (!fieldKey) {
      continue;
    }
    const operator = getFilterOperator(filter);
    const value = getFilterValue(filter);
    if (fieldKey === "option") {
      clauses.push(compileOptionNameValueFilter(filter?.optionName, operator, value));
      continue;
    }
    const config = VARIANT_FIELD_MAP[fieldKey];
    if (!config) {
      throw new Error(`Unsupported variant filter field: ${fieldKey}`);
    }

    if (config.type === "text") {
      clauses.push(compileTextFilter(config.prismaField, operator, value));
      continue;
    }
    if (config.type === "decimal") {
      clauses.push(compileDecimalFilter(config.prismaField, operator, value));
      continue;
    }
    if (config.type === "int") {
      clauses.push(compileIntFilter(config.prismaField, operator, value));
      continue;
    }
    if (config.type === "boolean") {
      clauses.push(compileBooleanFilter(config.prismaField, operator, value));
      continue;
    }

    throw new Error(`Unsupported variant filter type: ${config.type}`);
  }

  return { AND: clauses };
}

export function splitProductAndVariantFilters(rawFilterInput = []) {
  const productFilters = [];
  const variantFilters = [];
  const normalizedFilters = [];

  for (const filter of rawFilterInput || []) {
    const field = String(getFilterField(filter) || "").trim();
    if (!field) {
      productFilters.push(filter);
      continue;
    }

    if (VARIANT_FIELD_MAP[field]) {
      variantFilters.push(filter);
      continue;
    }

    const lowerField = field.toLowerCase();
    if (lowerField === "option") {
      variantFilters.push(filter);
      continue;
    }
    if (
      lowerField === "collection" ||
      lowerField === "collections" ||
      lowerField === "metafield" ||
      lowerField === "productmetafield" ||
      lowerField === "variantmetafield"
    ) {
      normalizedFilters.push(filter);
      continue;
    }

    productFilters.push(filter);
  }

  return {
    productFilters,
    variantFilters,
    normalizedFilters,
  };
}

export async function resolveVariantMetafieldMatchedVariantIds({
  db,
  shop,
  mirrorBatchId,
  namespace,
  key,
  operator,
  value,
}) {
  const normalizedOperator = normalizeOperator(operator);
  const normalizedValue = normalizeLower(value);
  const likeValue = `%${normalizedValue}%`;
  const parsedNumber = Number(value);
  const parsedDate = Number.isNaN(Date.parse(value)) ? null : new Date(value);
  const parsedBoolean = boolValue(value);

  const valueClause = (() => {
    if (normalizedOperator === "is empty" || normalizedOperator === "is empty/blank") {
      return db.sql`(m."valueTextNormalized" IS NULL OR m."valueTextNormalized" = '')`;
    }

    if (normalizedOperator === "is not empty") {
      return db.sql`(m."valueTextNormalized" IS NOT NULL AND m."valueTextNormalized" <> '')`;
    }

    if (normalizedOperator === "contains") {
      return db.sql`COALESCE(m."valueTextNormalized", '') LIKE ${likeValue}`;
    }

    if (normalizedOperator === "does not contain") {
      return db.sql`COALESCE(m."valueTextNormalized", '') NOT LIKE ${likeValue}`;
    }

    if ([">", ">=", "<", "<="].includes(normalizedOperator) && !Number.isNaN(parsedNumber)) {
      return db.sql`m."valueNumber" ${db.raw(normalizedOperator)} ${parsedNumber}`;
    }

    if ((normalizedOperator === "is before" || normalizedOperator === "is after") && parsedDate) {
      const op = normalizedOperator === "is before" ? "<" : ">";
      return db.sql`m."valueDate" ${db.raw(op)} ${parsedDate}`;
    }

    if ((normalizedOperator === "is" || normalizedOperator === "equals") && parsedBoolean !== null) {
      return db.sql`m."valueBoolean" = ${parsedBoolean}`;
    }

    if (normalizedOperator === "is not" || normalizedOperator === "not equals" || normalizedOperator === "!=") {
      return db.sql`COALESCE(m."valueTextNormalized", '') <> ${normalizedValue}`;
    }

    return db.sql`COALESCE(m."valueTextNormalized", '') = ${normalizedValue}`;
  })();

  const rows = await db.$queryRaw`
    SELECT DISTINCT m."ownerId" AS id
    FROM "MetafieldMirror" m
    WHERE m."shop" = ${shop}
      AND m."mirrorBatchId" = ${mirrorBatchId}
      AND m."ownerType" = 'VARIANT'
      AND m."namespace" = ${namespace}
      AND m."key" = ${key}
      AND ${valueClause}
  `;

  return rows.map((row) => row.id);
}

export {
  normalizeOperator,
  normalizeText,
  normalizeLower,
  decimalValue,
  intValue,
  boolValue,
  compileTextFilter,
  compileDecimalFilter,
  compileIntFilter,
  compileBooleanFilter,
  compileOptionNameValueFilter,
  VARIANT_FIELD_MAP,
  getFilterField,
  getFilterOperator,
  getFilterValue,
};

