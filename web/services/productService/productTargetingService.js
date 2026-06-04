import { db } from "../../repositories/repositoryDb.js";
import { Prisma } from "../../repositories/prismaTypes.js";
import crypto from "crypto";
import { buildNormalizedFilterPlan, mergeResolvedIdSets } from "./normalizedFilterPlan.js";
import { splitProductAndVariantFilters } from "./variantFilterCompiler.js";
import { recordMirrorAnomaly } from "../mirrorAnomalyService.js";
import { getStoreMirrorState } from "../mirrorHealthService.js";
import { adaptLegacyFilterParamsToAst } from "../targeting/adapters/legacyFilterParamsAdapter.js";
import { normalizeFilterAst } from "../targeting/normalize/filterAstNormalizer.js";
import { validateFilterAstOrThrow } from "../targeting/validate/filterAstValidator.js";
import { compileFilterAst } from "../targeting/compile/compileFilterAst.js";
import {
  TARGET_GRANULARITIES,
  TARGET_TYPES,
} from "../targeting/constants.js";

const MAX_ID_SET_SIZE = 50_000;
const MIRROR_ANOMALY_SEVERITY = Object.freeze({
  CRITICAL: "CRITICAL",
});
const NEGATIVE_OPERATOR_MODE = Object.freeze({
  LEGACY_EXCLUDE: "LEGACY_EXCLUDE",
  NOT_LIKE: "NOT_LIKE",
  ANTI_JOIN: "ANTI_JOIN",
});
const LEGACY_COMPAT = Object.freeze({
  negativeOperators: String(process.env.ENABLE_LEGACY_NEGATIVE_OPERATORS || "false").toLowerCase() === "true",
});
const deprecationWarnings = new Set();
function warnDeprecatedOnce(key, message) {
  if (deprecationWarnings.has(key)) return;
  deprecationWarnings.add(key);
  console.warn(`[DEPRECATED] ${message}`);
}

function mergeWithMirrorBatch(where, shop, mirrorBatchId) {
  if (!shop) {
    throw new Error("shop is required for mirror targeting");
  }

  if (!mirrorBatchId) {
    throw new Error("mirrorBatchId is required for mirror targeting");
  }

  return {
    AND: [
      where && typeof where === "object" ? where : {},
      { shop },
      { mirrorBatchId },
    ],
  };
}

function compileLegacyWhereViaEngine({
  filterParams = [],
  targetGranularity = "PRODUCT",
}) {
  if (!Array.isArray(filterParams) || filterParams.length === 0) {
    return {};
  }

  const filterAst = adaptLegacyFilterParamsToAst({
    filterParams: Array.isArray(filterParams) ? filterParams : [],
    targetGranularity,
    source: "MANUAL_PREVIEW",
  });
  const normalizedFilterAst = normalizeFilterAst(filterAst);
  validateFilterAstOrThrow(normalizedFilterAst, {
    targetGranularity,
    source: "MANUAL_PREVIEW",
  });
  const compiled = compileFilterAst(normalizedFilterAst, {
    dialect: "db",
    context: {
      targetGranularity,
      productVariantMode: "ANY",
      source: "MANUAL_PREVIEW",
    },
  });
  return compiled.where && typeof compiled.where === "object" ? compiled.where : {};
}

function assertUnscopedExplicitWhere(where) {
  if (!where || typeof where !== "object") return;
  const serialized = JSON.stringify(where);
  if (serialized.includes("\"shop\"") || serialized.includes("\"mirrorBatchId\"")) {
    throw new Error("explicitWhere must not include shop or mirrorBatchId");
  }
}

function normalizeText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function isNormalizedTargetingEnabled() {
  return process.env.ENABLE_NORMALIZED_TARGETING !== "false";
}

function isVariantFilterCompilerEnabled() {
  return String(process.env.ENABLE_VARIANT_FILTER_COMPILER || "false").toLowerCase() === "true";
}

function getNegativeOperatorMode() {
  warnDeprecatedOnce(
    "negative-operator-legacy-mode",
    "Legacy negative-operator compatibility path is deprecated. Migrate to TargetingEngineService operator registry semantics.",
  );
  const defaultMode = LEGACY_COMPAT.negativeOperators
    ? NEGATIVE_OPERATOR_MODE.LEGACY_EXCLUDE
    : NEGATIVE_OPERATOR_MODE.ANTI_JOIN;
  const raw = String(process.env.NEGATIVE_OPERATOR_MODE || defaultMode).toUpperCase();
  if (raw === NEGATIVE_OPERATOR_MODE.NOT_LIKE) return NEGATIVE_OPERATOR_MODE.NOT_LIKE;
  if (raw === NEGATIVE_OPERATOR_MODE.ANTI_JOIN) return NEGATIVE_OPERATOR_MODE.ANTI_JOIN;
  return NEGATIVE_OPERATOR_MODE.LEGACY_EXCLUDE;
}

function isDoesNotContain(operator) {
  // @deprecated Legacy custom operator normalization branch.
  return String(operator || "").toLowerCase() === "does not contain";
}

function mapOperatorForMerge(operator, mode) {
  // @deprecated Legacy custom operator normalization branch.
  if (isDoesNotContain(operator) && mode !== NEGATIVE_OPERATOR_MODE.LEGACY_EXCLUDE) {
    return "contains";
  }
  return operator;
}

function decodeCursorToken(cursorToken) {
  if (!cursorToken || typeof cursorToken !== "string") return null;
  try {
    const payload = JSON.parse(Buffer.from(cursorToken, "base64url").toString("utf8"));
    return payload && typeof payload === "object" ? payload : null;
  } catch (_error) {
    return null;
  }
}

function encodeCursorToken(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function hashFilterContext(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value || [])).digest("hex");
}

export async function computeTargetSnapshotChecksum({
  ownerType,
  ownerId,
  shop,
  mirrorBatchId,
  db = db,
}) {
  const hash = crypto.createHash("sha256");
  const PAGE_SIZE = 2000;
  let cursorOrdinal = null;

  while (true) {
    const rows = await db.targetSnapshot.findMany({
      where: {
        ownerType,
        ownerId,
        shop,
        mirrorBatchId,
        ...(cursorOrdinal !== null ? { ordinal: { gt: cursorOrdinal } } : {}),
      },
      select: {
        ordinal: true,
        targetIdentity: true,
        id: true,
      },
      orderBy: [{ ordinal: "asc" }, { id: "asc" }],
      take: PAGE_SIZE,
    });

    if (!rows.length) break;
    for (const row of rows) {
      hash.update(String(row.targetIdentity || ""));
      hash.update("\n");
    }
    cursorOrdinal = rows[rows.length - 1].ordinal;
    if (rows.length < PAGE_SIZE) break;
  }

  return hash.digest("hex");
}

function clampLimit(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function assertProductCursorContext({
  cursorPayload,
  sortKey,
  sortOrder,
  mirrorBatchId,
  filterHash,
}) {
  if (!cursorPayload) return;
  if (
    cursorPayload.sortKey !== sortKey ||
    cursorPayload.sortOrder !== sortOrder ||
    cursorPayload.mirrorBatchId !== mirrorBatchId ||
    cursorPayload.filterHash !== filterHash ||
    cursorPayload.targetType !== "PRODUCT"
  ) {
    throw new Error("Invalid cursor for current targeting query");
  }
}

function assertVariantCursorContext({
  cursorPayload,
  mirrorBatchId,
  filterHash,
  sortKey,
  sortOrder,
}) {
  if (!cursorPayload) return;
  if (
    cursorPayload.mirrorBatchId !== mirrorBatchId ||
    cursorPayload.filterHash !== filterHash ||
    cursorPayload.targetType !== "VARIANT" ||
    cursorPayload.sortKey !== sortKey ||
    cursorPayload.sortOrder !== sortOrder
  ) {
    throw new Error("Invalid cursor for current targeting query");
  }
}

function canonicalizeTargetId(rawId, targetType) {
  const value = String(rawId || "").trim();
  if (!value) {
    throw new Error("TARGET_ID_REQUIRED");
  }

  if (targetType === "PRODUCT") {
    return value.replace(/^PRODUCT:/i, "");
  }

  if (targetType === "VARIANT") {
    return value.replace(/^VARIANT:/i, "");
  }

  return value;
}

function normalizeTargetGranularity(value, fallback) {
  const raw = String(value || fallback || "").trim().toUpperCase();
  if (raw === TARGET_GRANULARITIES.VARIANT) return TARGET_GRANULARITIES.VARIANT;
  if (raw === TARGET_GRANULARITIES.PRODUCT_WITH_MATCHING_VARIANTS) {
    return TARGET_GRANULARITIES.PRODUCT_WITH_MATCHING_VARIANTS;
  }
  return TARGET_GRANULARITIES.PRODUCT;
}

function buildKeysetOrderBy(sortKey, sortOrder) {
  const dir = String(sortOrder || "asc").toLowerCase() === "desc" ? "desc" : "asc";
  if (sortKey === "TITLE") return [{ title: dir }, { id: dir }];
  if (sortKey === "CREATED_AT") return [{ createdAt: dir }, { id: dir }];
  if (sortKey === "UPDATED_AT") return [{ updatedAt: dir }, { id: dir }];
  return [{ id: dir }];
}

function buildKeysetWhere(sortKey, sortOrder, cursor) {
  if (!cursor || !cursor.id) return null;
  const isAsc = String(sortOrder || "asc").toLowerCase() !== "desc";
  const cmp = isAsc ? "gt" : "lt";

  if (sortKey === "TITLE" && typeof cursor.title === "string") {
    return {
      OR: [
        { title: { [cmp]: cursor.title } },
        { AND: [{ title: cursor.title }, { id: { [cmp]: cursor.id } }] },
      ],
    };
  }

  if (sortKey === "CREATED_AT" && cursor.createdAt) {
    const dt = new Date(cursor.createdAt);
    if (!Number.isNaN(dt.getTime())) {
      return {
        OR: [
          { createdAt: { [cmp]: dt } },
          { AND: [{ createdAt: dt }, { id: { [cmp]: cursor.id } }] },
        ],
      };
    }
  }

  if (sortKey === "UPDATED_AT" && cursor.updatedAt) {
    const dt = new Date(cursor.updatedAt);
    if (!Number.isNaN(dt.getTime())) {
      return {
        OR: [
          { updatedAt: { [cmp]: dt } },
          { AND: [{ updatedAt: dt }, { id: { [cmp]: cursor.id } }] },
        ],
      };
    }
  }

  return { id: { [cmp]: cursor.id } };
}

function buildVariantKeysetOrderBy(sortKey, sortOrder) {
  const dir = String(sortOrder || "asc").toLowerCase() === "desc" ? "desc" : "asc";

  if (sortKey === "SKU") return [{ sku: dir }, { id: dir }];
  if (sortKey === "PRICE") return [{ price: dir }, { id: dir }];
  if (sortKey === "POSITION") return [{ productId: dir }, { position: dir }, { id: dir }];

  return [{ id: dir }];
}

function buildVariantKeysetWhere(sortKey, sortOrder, cursor) {
  if (!cursor || !cursor.id) return null;

  const isAsc = String(sortOrder || "asc").toLowerCase() !== "desc";
  const cmp = isAsc ? "gt" : "lt";

  if (sortKey === "SKU" && typeof cursor.sku === "string") {
    return {
      OR: [
        { sku: { [cmp]: cursor.sku } },
        { AND: [{ sku: cursor.sku }, { id: { [cmp]: cursor.id } }] },
      ],
    };
  }

  if (sortKey === "PRICE" && cursor.price !== null && cursor.price !== undefined) {
    return {
      OR: [
        { price: { [cmp]: new db.Decimal(cursor.price) } },
        {
          AND: [
            { price: new db.Decimal(cursor.price) },
            { id: { [cmp]: cursor.id } },
          ],
        },
      ],
    };
  }

  if (
    sortKey === "POSITION" &&
    cursor.productId &&
    Number.isInteger(Number(cursor.position))
  ) {
    const position = Number(cursor.position);

    return {
      OR: [
        { productId: { [cmp]: cursor.productId } },
        {
          AND: [
            { productId: cursor.productId },
            { position: { [cmp]: position } },
          ],
        },
        {
          AND: [
            { productId: cursor.productId },
            { position },
            { id: { [cmp]: cursor.id } },
          ],
        },
      ],
    };
  }

  return { id: { [cmp]: cursor.id } };
}

async function resolveCollectionMatchedIds({
  shop,
  mirrorBatchId,
  operator,
  collectionId = "",
  title = "",
  handle = "",
}) {
  const likeValue = `%${title}%`;
  const normalizedOperator = operator.toLowerCase();
  const negativeOperatorMode = getNegativeOperatorMode();

  if (normalizedOperator === "is empty" || normalizedOperator === "is empty/blank") {
    const rows = await db.$queryRaw`
      SELECT p."id"
      FROM "Product" p
      WHERE p."shop" = ${shop}
        AND p."mirrorBatchId" = ${mirrorBatchId}
        AND NOT EXISTS (
          SELECT 1
          FROM "ProductCollection" pc
          WHERE pc."shop" = p."shop"
            AND pc."mirrorBatchId" = p."mirrorBatchId"
            AND pc."productId" = p."id"
        )
    `;
    return new Set(rows.map((row) => row.id));
  }

  if (normalizedOperator === "is not empty") {
    const rows = await db.$queryRaw`
      SELECT DISTINCT pc."productId" AS id
      FROM "ProductCollection" pc
      WHERE pc."shop" = ${shop}
        AND pc."mirrorBatchId" = ${mirrorBatchId}
    `;
    return new Set(rows.map((row) => row.id));
  }

  const containsExpr = (() => {
    if (collectionId) {
      return db.sql`c."shopifyId" = ${collectionId}`;
    }
    if (handle) {
      return db.sql`LOWER(COALESCE(c."handle", '')) LIKE LOWER(${`%${handle}%`})`;
    }
    return db.sql`LOWER(COALESCE(c."title", '')) LIKE LOWER(${likeValue})`;
  })();

  if (normalizedOperator === "does not contain" && negativeOperatorMode === NEGATIVE_OPERATOR_MODE.ANTI_JOIN) {
    const rows = await db.$queryRaw`
      SELECT p."id"
      FROM "Product" p
      WHERE p."shop" = ${shop}
        AND p."mirrorBatchId" = ${mirrorBatchId}
        AND NOT EXISTS (
          SELECT 1
          FROM "ProductCollection" pc
          INNER JOIN "Collection" c
            ON c."shop" = pc."shop"
           AND c."mirrorBatchId" = pc."mirrorBatchId"
           AND c."shopifyId" = pc."collectionId"
          WHERE pc."shop" = p."shop"
            AND pc."mirrorBatchId" = p."mirrorBatchId"
            AND pc."productId" = p."id"
            AND ${containsExpr}
        )
    `;
    return new Set(rows.map((row) => row.id));
  }

  const comparator = (() => {
    if (collectionId) {
      return db.sql`c."shopifyId" = ${collectionId}`;
    }
    if (handle) {
      if (normalizedOperator === "contains" || normalizedOperator === "does not contain") {
        if (normalizedOperator === "does not contain" && negativeOperatorMode === NEGATIVE_OPERATOR_MODE.NOT_LIKE) {
          return db.sql`LOWER(COALESCE(c."handle", '')) NOT LIKE LOWER(${`%${handle}%`})`;
        }
        return db.sql`LOWER(COALESCE(c."handle", '')) LIKE LOWER(${`%${handle}%`})`;
      }
      return db.sql`LOWER(COALESCE(c."handle", '')) = LOWER(${handle})`;
    }
    if (normalizedOperator === "contains" || normalizedOperator === "does not contain") {
      if (normalizedOperator === "does not contain" && negativeOperatorMode === NEGATIVE_OPERATOR_MODE.NOT_LIKE) {
        return db.sql`LOWER(COALESCE(c."title", '')) NOT LIKE LOWER(${likeValue})`;
      }
      return db.sql`LOWER(COALESCE(c."title", '')) LIKE LOWER(${likeValue})`;
    }
    return db.sql`LOWER(COALESCE(c."title", '')) = LOWER(${title})`;
  })();

  const rows = await db.$queryRaw`
    SELECT DISTINCT pc."productId" AS id
    FROM "ProductCollection" pc
    INNER JOIN "Collection" c
      ON c."shop" = pc."shop"
     AND c."mirrorBatchId" = pc."mirrorBatchId"
     AND c."shopifyId" = pc."collectionId"
    WHERE pc."shop" = ${shop}
      AND pc."mirrorBatchId" = ${mirrorBatchId}
      AND ${comparator}
  `;
  return new Set(rows.map((row) => row.id));
}

async function resolveMetafieldMatchedIds({
  shop,
  mirrorBatchId,
  namespace,
  key,
  operator,
  value,
  ownerType,
}) {
  const normalizedOperator = operator.toLowerCase();
  const negativeOperatorMode = getNegativeOperatorMode();
  const normalizedValue = String(value || "").trim().toLowerCase();
  const likeValue = `%${normalizedValue}%`;
  const parsedNumber = Number(value);
  const parsedDate = Number.isNaN(Date.parse(value)) ? null : new Date(value);
  const parsedBoolean = String(value).toLowerCase() === "true"
    ? true
    : String(value).toLowerCase() === "false"
      ? false
      : null;
  const valueClause = (() => {
    if (normalizedOperator === "is empty" || normalizedOperator === "is empty/blank") {
      return db.sql`(m."valueTextNormalized" IS NULL OR m."valueTextNormalized" = '')`;
    }
    if (normalizedOperator === "is not empty") {
      return db.sql`(m."valueTextNormalized" IS NOT NULL AND m."valueTextNormalized" <> '')`;
    }
    if ((normalizedOperator === ">" || normalizedOperator === ">=" || normalizedOperator === "<" || normalizedOperator === "<=") && !Number.isNaN(parsedNumber)) {
      const op = normalizedOperator === ">" ? ">" : normalizedOperator === ">=" ? ">=" : normalizedOperator === "<" ? "<" : "<=";
      return db.sql`m."valueNumber" ${db.raw(op)} ${parsedNumber}`;
    }
    if ((normalizedOperator === "is before" || normalizedOperator === "is after") && parsedDate) {
      const op = normalizedOperator === "is before" ? "<" : ">";
      return db.sql`m."valueDate" ${db.raw(op)} ${parsedDate}`;
    }
    if ((normalizedOperator === "is" || normalizedOperator === "equals") && parsedBoolean !== null) {
      return db.sql`m."valueBoolean" = ${parsedBoolean}`;
    }
    if (normalizedOperator === "contains" || normalizedOperator === "does not contain") {
      if (normalizedOperator === "does not contain" && negativeOperatorMode === NEGATIVE_OPERATOR_MODE.NOT_LIKE) {
        return db.sql`COALESCE(m."valueTextNormalized", '') NOT LIKE ${likeValue}`;
      }
      return db.sql`COALESCE(m."valueTextNormalized", '') LIKE ${likeValue}`;
    }
    return db.sql`COALESCE(m."valueTextNormalized", '') = ${normalizedValue}`;
  })();

  if (normalizedOperator === "does not contain" && negativeOperatorMode === NEGATIVE_OPERATOR_MODE.ANTI_JOIN) {
    if (ownerType === "VARIANT") {
      const rows = await db.$queryRaw`
        SELECT p."id"
        FROM "Product" p
        WHERE p."shop" = ${shop}
          AND p."mirrorBatchId" = ${mirrorBatchId}
          AND NOT EXISTS (
            SELECT 1
            FROM "Variant" v
            INNER JOIN "MetafieldMirror" m
              ON m."shop" = v."shop"
             AND m."mirrorBatchId" = v."mirrorBatchId"
             AND m."ownerType" = 'VARIANT'
             AND m."ownerId" = v."id"
            WHERE v."shop" = p."shop"
              AND v."mirrorBatchId" = p."mirrorBatchId"
              AND v."productId" = p."id"
              AND m."namespace" = ${namespace}
              AND m."key" = ${key}
              AND COALESCE(m."valueTextNormalized", '') LIKE ${likeValue}
          )
      `;
      return new Set(rows.map((row) => row.id));
    }

    const rows = await db.$queryRaw`
      SELECT p."id"
      FROM "Product" p
      WHERE p."shop" = ${shop}
        AND p."mirrorBatchId" = ${mirrorBatchId}
        AND NOT EXISTS (
          SELECT 1
          FROM "MetafieldMirror" m
          WHERE m."shop" = p."shop"
            AND m."mirrorBatchId" = p."mirrorBatchId"
            AND m."ownerType" = 'PRODUCT'
            AND m."ownerId" = p."id"
            AND m."namespace" = ${namespace}
            AND m."key" = ${key}
            AND COALESCE(m."valueTextNormalized", '') LIKE ${likeValue}
        )
    `;
    return new Set(rows.map((row) => row.id));
  }

  if (ownerType === "VARIANT") {
    const rows = await db.$queryRaw`
      SELECT DISTINCT v."productId" AS id
      FROM "MetafieldMirror" m
      INNER JOIN "Variant" v
        ON v."shop" = m."shop"
       AND v."mirrorBatchId" = m."mirrorBatchId"
       AND v."id" = m."ownerId"
      WHERE m."shop" = ${shop}
        AND m."mirrorBatchId" = ${mirrorBatchId}
        AND m."ownerType" = 'VARIANT'
        AND m."namespace" = ${namespace}
        AND m."key" = ${key}
        AND ${valueClause}
    `;
    return new Set(rows.map((row) => row.id));
  }

  const rows = await db.$queryRaw`
    SELECT DISTINCT m."ownerId" AS id
    FROM "MetafieldMirror" m
    WHERE m."shop" = ${shop}
      AND m."mirrorBatchId" = ${mirrorBatchId}
      AND m."ownerType" = 'PRODUCT'
      AND m."namespace" = ${namespace}
      AND m."key" = ${key}
      AND ${valueClause}
  `;
  return new Set(rows.map((row) => row.id));
}

async function resolveMetafieldMatchedVariantIds({
  shop,
  mirrorBatchId,
  namespace,
  key,
  operator,
  value,
}) {
  const normalizedOperator = operator.toLowerCase();
  const negativeOperatorMode = getNegativeOperatorMode();
  const normalizedValue = String(value || "").trim().toLowerCase();
  const likeValue = `%${normalizedValue}%`;
  const parsedNumber = Number(value);
  const parsedDate = Number.isNaN(Date.parse(value)) ? null : new Date(value);
  const parsedBoolean = String(value).toLowerCase() === "true"
    ? true
    : String(value).toLowerCase() === "false"
      ? false
      : null;

  const valueClause = (() => {
    if (normalizedOperator === "is empty" || normalizedOperator === "is empty/blank") {
      return db.sql`(m."valueTextNormalized" IS NULL OR m."valueTextNormalized" = '')`;
    }
    if (normalizedOperator === "is not empty") {
      return db.sql`(m."valueTextNormalized" IS NOT NULL AND m."valueTextNormalized" <> '')`;
    }
    if ((normalizedOperator === ">" || normalizedOperator === ">=" || normalizedOperator === "<" || normalizedOperator === "<=") && !Number.isNaN(parsedNumber)) {
      const op = normalizedOperator === ">" ? ">" : normalizedOperator === ">=" ? ">=" : normalizedOperator === "<" ? "<" : "<=";
      return db.sql`m."valueNumber" ${db.raw(op)} ${parsedNumber}`;
    }
    if ((normalizedOperator === "is before" || normalizedOperator === "is after") && parsedDate) {
      const op = normalizedOperator === "is before" ? "<" : ">";
      return db.sql`m."valueDate" ${db.raw(op)} ${parsedDate}`;
    }
    if ((normalizedOperator === "is" || normalizedOperator === "equals") && parsedBoolean !== null) {
      return db.sql`m."valueBoolean" = ${parsedBoolean}`;
    }
    if (normalizedOperator === "contains" || normalizedOperator === "does not contain") {
      if (normalizedOperator === "does not contain" && negativeOperatorMode === NEGATIVE_OPERATOR_MODE.NOT_LIKE) {
        return db.sql`COALESCE(m."valueTextNormalized", '') NOT LIKE ${likeValue}`;
      }
      return db.sql`COALESCE(m."valueTextNormalized", '') LIKE ${likeValue}`;
    }
    return db.sql`COALESCE(m."valueTextNormalized", '') = ${normalizedValue}`;
  })();

  if (normalizedOperator === "does not contain" && negativeOperatorMode === NEGATIVE_OPERATOR_MODE.ANTI_JOIN) {
    const rows = await db.$queryRaw`
      SELECT v."id"
      FROM "Variant" v
      WHERE v."shop" = ${shop}
        AND v."mirrorBatchId" = ${mirrorBatchId}
        AND NOT EXISTS (
          SELECT 1
          FROM "MetafieldMirror" m
          WHERE m."shop" = v."shop"
            AND m."mirrorBatchId" = v."mirrorBatchId"
            AND m."ownerType" = 'VARIANT'
            AND m."ownerId" = v."id"
            AND m."namespace" = ${namespace}
            AND m."key" = ${key}
            AND COALESCE(m."valueTextNormalized", '') LIKE ${likeValue}
        )
    `;
    return new Set(rows.map((row) => row.id));
  }

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
  return new Set(rows.map((row) => row.id));
}

async function resolveCollectionMatchedVariantIds({
  shop,
  mirrorBatchId,
  operator,
  collectionId = "",
  title = "",
  handle = "",
}) {
  const productIds = await resolveCollectionMatchedIds({
    shop,
    mirrorBatchId,
    operator,
    collectionId,
    title,
    handle,
  });

  if (!productIds.size) return new Set();

  const rows = await db.variant.findMany({
    where: {
      shop,
      mirrorBatchId,
      productId: { in: Array.from(productIds) },
    },
    select: { id: true },
  });

  return new Set(rows.map((row) => row.id));
}

export async function resolveNormalizedFilterProductIds({
  shop,
  mirrorBatchId,
  filterParams = [],
}) {
  const plan = buildNormalizedFilterPlan(filterParams);

  if (!isNormalizedTargetingEnabled()) {
    if (plan.length > 0) {
      throw new Error(
        "Normalized targeting is required for collection/metafield filters. Enable normalized targeting or remove those filters.",
      );
    }
    return { includeIds: null, excludeIds: [] };
  }

  if (!plan.length) {
    return { includeIds: null, excludeIds: [] };
  }

  const steps = [];
  const negativeOperatorMode = getNegativeOperatorMode();

  for (const filter of plan) {
    let matchedSet = new Set();
    if (filter.type === "collection") {
      matchedSet = await resolveCollectionMatchedIds({
        shop,
        mirrorBatchId,
        operator: filter.operator,
        collectionId: filter.collectionId,
        title: filter.title,
        handle: filter.handle,
      });
    } else if (filter.type === "metafield") {
      matchedSet = await resolveMetafieldMatchedIds({
        shop,
        mirrorBatchId,
        namespace: filter.namespace,
        key: filter.key,
        operator: filter.operator,
        value: filter.value,
        ownerType: filter.ownerType,
      });
    }

    steps.push({
      operator: mapOperatorForMerge(filter.operator, negativeOperatorMode),
      ids: Array.from(matchedSet),
    });
    if (matchedSet.size > MAX_ID_SET_SIZE) {
      throw new Error("Normalized filter result too large for in-memory ID resolution; use SQL targeting compiler.");
    }
  }

  return mergeResolvedIdSets(steps);
}

export async function resolveNormalizedFilterVariantIds({
  shop,
  mirrorBatchId,
  filterParams = [],
}) {
  const plan = buildNormalizedFilterPlan(filterParams);

  if (!isNormalizedTargetingEnabled()) {
    if (plan.length > 0) {
      throw new Error(
        "Normalized targeting is required for collection/metafield filters. Enable normalized targeting or remove those filters.",
      );
    }
    return { includeIds: null, excludeIds: [] };
  }

  if (!plan.length) {
    return { includeIds: null, excludeIds: [] };
  }

  const steps = [];
  const negativeOperatorMode = getNegativeOperatorMode();

  for (const filter of plan) {
    let matchedSet = new Set();
    if (filter.type === "collection") {
      matchedSet = await resolveCollectionMatchedVariantIds({
        shop,
        mirrorBatchId,
        operator: filter.operator,
        collectionId: filter.collectionId,
        title: filter.title,
        handle: filter.handle,
      });
    } else if (filter.type === "metafield") {
      if (filter.ownerType === "VARIANT") {
        matchedSet = await resolveMetafieldMatchedVariantIds({
          shop,
          mirrorBatchId,
          namespace: filter.namespace,
          key: filter.key,
          operator: filter.operator,
          value: filter.value,
        });
      } else {
        const matchedProductIds = await resolveMetafieldMatchedIds({
          shop,
          mirrorBatchId,
          namespace: filter.namespace,
          key: filter.key,
          operator: filter.operator,
          value: filter.value,
          ownerType: "PRODUCT",
        });
        if (matchedProductIds.size) {
          const rows = await db.variant.findMany({
            where: {
              shop,
              mirrorBatchId,
              productId: { in: Array.from(matchedProductIds) },
            },
            select: { id: true },
          });
          matchedSet = new Set(rows.map((row) => row.id));
        }
      }
    }

    steps.push({
      operator: mapOperatorForMerge(filter.operator, negativeOperatorMode),
      ids: Array.from(matchedSet),
    });
    if (matchedSet.size > MAX_ID_SET_SIZE) {
      throw new Error("Normalized filter result too large for in-memory ID resolution; use SQL targeting compiler.");
    }
  }

  return mergeResolvedIdSets(steps);
}

export async function getActiveMirrorBatchId(shop, { purpose = "EXECUTE" } = {}) {
  const store = await getStoreMirrorState(shop);
  if (!store) {
    throw new Error("Store not found");
  }

  if (!store.activeMirrorBatchId) {
    throw new Error("Mirror batch unavailable. Run sync before preview or execution.");
  }

  const executionUnsafe = store.mirrorHealthState !== "HEALTHY" || store.repairRequired;
  const previewUnsafe = ["UNSAFE", "REPAIR_REQUIRED"].includes(store.mirrorHealthState) || store.repairRequired;
  const isPreviewPurpose = purpose === "PREVIEW" || purpose === "EXPORT";

  if (purpose === "EXECUTE" && executionUnsafe) {
    throw new Error(
      `Mirror is not safe for execution (state=${store.mirrorHealthState}, reason=${store.staleReason || "unknown"})`,
    );
  }
  if (isPreviewPurpose && previewUnsafe) {
    const staleReason = String(store.staleReason || "").toUpperCase();
    const syncRunning = store.isProductSyncing === true || store.isProductInitialySyning === true;
    const activeProductRowCount = await db.product.count({
      where: {
        shop,
        mirrorBatchId: store.activeMirrorBatchId,
      },
    });
    const canUseExistingMirrorDuringBackgroundRefresh =
      syncRunning &&
      activeProductRowCount > 0;
    const canUseExistingMirrorAfterFailedRefresh =
      staleReason === "FULL_SYNC_FAILED" &&
      !syncRunning &&
      activeProductRowCount > 0;

    // Preview/list pages should keep using the last active mirror while a
    // refresh is running; navigation must not blank a valid product table.
    if (canUseExistingMirrorDuringBackgroundRefresh || canUseExistingMirrorAfterFailedRefresh) {
      return store.activeMirrorBatchId;
    }

    throw new Error(
      `Mirror is not safe for ${purpose.toLowerCase()} (state=${store.mirrorHealthState}, reason=${store.staleReason || "unknown"})`,
    );
  }

  return store.activeMirrorBatchId;
}

export async function resolveCanonicalProductTarget({
  shop,
  filterParams = [],
  queryParams = {},
  explicitWhere = null,
  explicitProductIds = [],
  sampleLimit = 20,
  freeze = false,
  ownerType = null,
  ownerId = null,
}) {
  assertUnscopedExplicitWhere(explicitWhere);
  const mirrorBatchId = await getActiveMirrorBatchId(shop, {
    purpose: freeze ? "EXECUTE" : "PREVIEW",
  });
  const baseWhere = explicitWhere || compileLegacyWhereViaEngine({
    filterParams,
    targetGranularity: "PRODUCT",
  });
  const where = mergeWithMirrorBatch(baseWhere, shop, mirrorBatchId);
  const normalizedTargetIds = await resolveNormalizedFilterProductIds({
    shop,
    mirrorBatchId,
    filterParams,
  });

  if (Array.isArray(explicitProductIds) && explicitProductIds.length > 0) {
    where.AND.push({
      id: {
        in: explicitProductIds,
      },
    });
  }

  if (Array.isArray(normalizedTargetIds.includeIds)) {
    if (!normalizedTargetIds.includeIds.length) {
      where.AND.push({ id: { in: ["__no_match__"] } });
    } else {
      where.AND.push({ id: { in: normalizedTargetIds.includeIds } });
    }
  }

  if (Array.isArray(normalizedTargetIds.excludeIds) && normalizedTargetIds.excludeIds.length > 0) {
    where.AND.push({
      id: {
        notIn: normalizedTargetIds.excludeIds,
      },
    });
  }

  const sortKey = String(queryParams.sortKey || "ID").toUpperCase();
  const sortOrder = String(queryParams.sortOrder || "asc").toLowerCase();
  const filterHash = hashFilterContext({
    filterParams,
    explicitWhere,
    explicitProductIds,
    includeIds: normalizedTargetIds.includeIds,
    excludeIds: normalizedTargetIds.excludeIds,
  });
  if (sortKey === "CREATED_AT") {
    where.AND.push({ createdAt: { not: null } });
  }
  if (sortKey === "UPDATED_AT") {
    where.AND.push({ updatedAt: { not: null } });
  }
  const orderBy = buildKeysetOrderBy(sortKey, sortOrder);
  const limit = clampLimit(queryParams.limit, sampleLimit, sampleLimit);
  const cursorToken = typeof queryParams.cursor === "string" ? queryParams.cursor : null;
  const cursorPayload = decodeCursorToken(cursorToken);
  assertProductCursorContext({
    cursorPayload,
    sortKey,
    sortOrder,
    mirrorBatchId,
    filterHash,
  });
  const keysetWhere = buildKeysetWhere(sortKey, sortOrder, cursorPayload);
  if (keysetWhere) {
    where.AND.push(keysetWhere);
  }

  const fetchLimit = clampLimit(limit, sampleLimit, sampleLimit);

  const [count, rows] = await Promise.all([
    db.product.count({ where }),
    db.product.findMany({
      where,
      select: {
        id: true,
        title: true,
        status: true,
        productType: true,
        vendor: true,
        totalInventory: true,
        featuredImageUrl: true,
        categoryName: true,
        handle: true,
        templateSuffix: true,
        variantCount: true,
        visibleOnlineStore: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy,
      take: fetchLimit + 1,
    }),
  ]);

  const hasNextPage = rows.length > fetchLimit;
  const sampleProducts = hasNextPage ? rows.slice(0, fetchLimit) : rows;
  const last = sampleProducts[sampleProducts.length - 1] || null;
  const nextCursor = last
    ? encodeCursorToken({
        id: last.id,
        title: last.title || null,
        createdAt: last.createdAt ? new Date(last.createdAt).toISOString() : null,
        updatedAt: last.updatedAt ? new Date(last.updatedAt).toISOString() : null,
        sortKey,
        sortOrder,
        mirrorBatchId,
        filterHash,
        targetType: "PRODUCT",
      })
    : null;

  let frozenCount = null;
  if (freeze && ownerType && ownerId) {
    frozenCount = await freezeTargetSnapshot({
      ownerType,
      ownerId,
      shop,
      where,
      mirrorBatchId,
      filterHash,
      targetType: "PRODUCT",
      targetGranularity: "PRODUCT",
    });

    if (frozenCount !== count) {
      await markPreviewExecutionMismatch({
        shop,
        ownerType,
        ownerId,
        previewCount: count,
        frozenCount,
      });
      throw new Error(`Target freeze mismatch: preview=${count}, frozen=${frozenCount}`);
    }
  }

  const outputProducts = sampleProducts.map((item) => {
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = item;
    return rest;
  });

  return {
    mirrorBatchId,
    where,
    filterHash,
    count,
    frozenCount,
    sampleProducts: outputProducts,
    pagination: {
      total: count,
      limit,
      hasNextPage,
      hasPrevPage: Boolean(cursorPayload),
      cursor: cursorToken,
      nextCursor,
      nextCursorVariantId: nextCursor ? (decodeCursorToken(nextCursor)?.id || null) : null,
    },
  };
}

export async function resolveCanonicalVariantTarget({
  shop,
  filterParams = [],
  queryParams = {},
  explicitWhere = null,
  explicitProductIds = [],
  explicitVariantIds = [],
  sampleLimit = 20,
  freeze = false,
  ownerType = null,
  ownerId = null,
}) {
  assertUnscopedExplicitWhere(explicitWhere);
  const mirrorBatchId = await getActiveMirrorBatchId(shop, {
    purpose: freeze ? "EXECUTE" : "PREVIEW",
  });
  const variantCompilerEnabled = isVariantFilterCompilerEnabled();
  const splitFilters = variantCompilerEnabled
    ? splitProductAndVariantFilters(filterParams)
    : {
        productFilters: filterParams,
        variantFilters: [],
        normalizedFilters: filterParams,
      };
  const {
    productFilters,
    variantFilters,
    normalizedFilters,
  } = splitFilters;
  const productBaseWhere = explicitWhere || compileLegacyWhereViaEngine({
    filterParams: productFilters,
    targetGranularity: "PRODUCT",
  });
  const productWhere = mergeWithMirrorBatch(productBaseWhere, shop, mirrorBatchId);
  const normalizedVariantTargetIds = await resolveNormalizedFilterVariantIds({
    shop,
    mirrorBatchId,
    filterParams: normalizedFilters,
  });

  if (Array.isArray(explicitProductIds) && explicitProductIds.length > 0) {
    productWhere.AND.push({
      id: {
        in: explicitProductIds,
      },
    });
  }

  const variantWhere = variantCompilerEnabled
    ? compileLegacyWhereViaEngine({
        filterParams: variantFilters,
        targetGranularity: "VARIANT",
      })
    : {
        shop,
        mirrorBatchId,
      };
  variantWhere.AND = Array.isArray(variantWhere.AND) ? variantWhere.AND : [];
  variantWhere.product = productWhere;

  if (Array.isArray(explicitVariantIds) && explicitVariantIds.length > 0) {
    variantWhere.AND.push({ id: { in: explicitVariantIds } });
  }

  if (Array.isArray(normalizedVariantTargetIds.includeIds)) {
    variantWhere.AND.push({
      id: {
        in: normalizedVariantTargetIds.includeIds.length ? normalizedVariantTargetIds.includeIds : ["__no_match__"],
      },
    });
  }

  if (Array.isArray(normalizedVariantTargetIds.excludeIds) && normalizedVariantTargetIds.excludeIds.length > 0) {
    variantWhere.AND.push({
      id: {
        notIn: normalizedVariantTargetIds.excludeIds,
      },
    });
  }

  const filterHash = hashFilterContext({
    productFilters,
    variantFilters,
    normalizedFilters,
    explicitWhere,
    explicitProductIds,
    explicitVariantIds,
    includeIds: normalizedVariantTargetIds.includeIds,
    excludeIds: normalizedVariantTargetIds.excludeIds,
  });
  const sortKey = String(queryParams.sortKey || "ID").toUpperCase();
  const sortOrder = String(queryParams.sortOrder || "asc").toLowerCase();
  const orderBy = buildVariantKeysetOrderBy(sortKey, sortOrder);
  const limit = clampLimit(queryParams.limit, sampleLimit, sampleLimit);
  const cursorToken = typeof queryParams.cursor === "string" ? queryParams.cursor : null;
  const cursorPayload = decodeCursorToken(cursorToken);
  assertVariantCursorContext({
    cursorPayload,
    mirrorBatchId,
    filterHash,
    sortKey,
    sortOrder,
  });
  const keysetWhere = buildVariantKeysetWhere(sortKey, sortOrder, cursorPayload);
  if (keysetWhere) {
    variantWhere.AND = Array.isArray(variantWhere.AND)
      ? [...variantWhere.AND, keysetWhere]
      : [keysetWhere];
  }

  const fetchLimit = clampLimit(limit, sampleLimit, sampleLimit);
  const [count, rows] = await db.$transaction([
    db.variant.count({ where: variantWhere }),
    db.variant.findMany({
      where: variantWhere,
      select: {
        id: true,
        productId: true,
        title: true,
        sku: true,
        barcode: true,
        price: true,
        compareAtPrice: true,
        inventoryQuantity: true,
        position: true,
      },
      orderBy,
      take: fetchLimit + 1,
    }),
  ]);

  const hasNextPage = rows.length > fetchLimit;
  const sampleVariants = hasNextPage ? rows.slice(0, fetchLimit) : rows;
  const last = sampleVariants[sampleVariants.length - 1] || null;
  const nextCursor = sampleVariants.length
    ? encodeCursorToken({
        id: last.id,
        productId: last.productId,
        sku: last.sku || null,
        price: last.price?.toString?.() || null,
        position: last.position ?? null,
        sortKey,
        sortOrder,
        mirrorBatchId,
        filterHash,
        targetType: "VARIANT",
      })
    : null;

  let frozenCount = null;
  if (freeze && ownerType && ownerId) {
    frozenCount = await freezeTargetSnapshot({
      ownerType,
      ownerId,
      shop,
      where: productWhere,
      mirrorBatchId,
      filterHash,
      targetType: "VARIANT",
      targetGranularity: "VARIANT",
      explicitVariantIds,
    });

    if (frozenCount !== count) {
      await markPreviewExecutionMismatch({
        shop,
        ownerType,
        ownerId,
        previewCount: count,
        frozenCount,
      });
      throw new Error(`Target freeze mismatch: preview=${count}, frozen=${frozenCount}`);
    }
  }

  return {
    mirrorBatchId,
    where: variantWhere,
    filterHash,
    count,
    frozenCount,
    sampleVariants,
    pagination: {
      total: count,
      limit,
      hasNextPage,
      hasPrevPage: Boolean(cursorPayload),
      cursor: cursorToken,
      nextCursor,
    },
  };
}

export async function resolveCanonicalTarget({
  shop,
  targetType = "PRODUCT",
  filterParams = [],
  queryParams = {},
  explicitWhere = null,
  explicitProductIds = [],
  explicitVariantIds = [],
  sampleLimit = 20,
  freeze = false,
  ownerType = null,
  ownerId = null,
}) {
  if (targetType === "PRODUCT") {
    return resolveCanonicalProductTarget({
      shop,
      filterParams,
      queryParams,
      explicitWhere,
      explicitProductIds,
      sampleLimit,
      freeze,
      ownerType,
      ownerId,
    });
  }

  if (targetType === "VARIANT") {
    return resolveCanonicalVariantTarget({
      shop,
      filterParams,
      queryParams,
      explicitWhere,
      explicitProductIds,
      explicitVariantIds,
      sampleLimit,
      freeze,
      ownerType,
      ownerId,
    });
  }

  throw new Error(`Unsupported targetType: ${targetType}`);
}

export async function freezeProductTargetSnapshot({
  ownerType,
  ownerId,
  shop,
  where,
  mirrorBatchId,
  filterHash,
  targetGranularity = TARGET_GRANULARITIES.PRODUCT,
  source = null,
  db = db,
}) {
  if (!filterHash) {
    throw new Error("FILTER_HASH_REQUIRED");
  }
  const BATCH_SIZE = 1000;
  let cursorId = null;
  let totalInserted = 0;
  let ordinal = 0;

  while (true) {
    const snapshotWhere = {
      AND: [
        ...(Array.isArray(where?.AND) ? where.AND : [where]),
        ...(cursorId ? [{ id: { gt: cursorId } }] : []),
      ],
    };

    const products = await db.product.findMany({
      where: snapshotWhere,
      select: {
        id: true,
        title: true,
        status: true,
        vendor: true,
        productType: true,
        handle: true,
      },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
    });

    if (!products.length) {
      break;
    }

    await db.targetSnapshot.createMany({
      data: products.map((product, index) => ({
        ownerType,
        ownerId,
        shop,
        mirrorBatchId,
        targetType: TARGET_TYPES.PRODUCT,
        targetGranularity,
        source,
        productId: product.id,
        variantId: null,
        targetIdentity: `PRODUCT:${product.id}`,
        ordinal: ordinal + index,
        filterHash,
        beforeValues: {
          title: product.title ?? null,
          status: product.status ?? null,
          vendor: product.vendor ?? null,
          productType: product.productType ?? null,
          handle: product.handle ?? null,
        },
      })),
      skipDuplicates: true,
    });

    totalInserted += products.length;
    ordinal += products.length;
    cursorId = products[products.length - 1].id;
  }

  return totalInserted;
}

export async function freezeVariantTargetSnapshot({
  ownerType,
  ownerId,
  shop,
  productWhere,
  mirrorBatchId,
  filterHash,
  targetGranularity = TARGET_GRANULARITIES.VARIANT,
  explicitVariantIds = [],
  source = null,
  db = db,
}) {
  if (!filterHash) {
    throw new Error("FILTER_HASH_REQUIRED");
  }
  const BATCH_SIZE = 1000;
  let cursorId = null;
  let totalInserted = 0;
  let ordinal = 0;

  while (true) {
    const andClauses = [
      { shop },
      { mirrorBatchId },
      { product: productWhere },
    ];

    if (Array.isArray(explicitVariantIds) && explicitVariantIds.length > 0) {
      andClauses.push({ id: { in: explicitVariantIds } });
    }

    if (cursorId) {
      andClauses.push({ id: { gt: cursorId } });
    }

    const variantWhere = { AND: andClauses };

    const variants = await db.variant.findMany({
      where: variantWhere,
      select: {
        id: true,
        productId: true,
        title: true,
        sku: true,
        barcode: true,
        price: true,
        compareAtPrice: true,
        inventoryQuantity: true,
        inventoryItemId: true,
        inventoryPolicy: true,
        taxable: true,
        taxCode: true,
        cost: true,
        tracked: true,
        physicalProduct: true,
        option1Value: true,
        option2Value: true,
        option3Value: true,
        weight: true,
        weightUnit: true,
      },
      orderBy: { id: "asc" },
      take: BATCH_SIZE,
    });

    if (!variants.length) {
      break;
    }

    await db.targetSnapshot.createMany({
      data: variants.map((variant, index) => ({
        ownerType,
        ownerId,
        shop,
        mirrorBatchId,
        targetType: TARGET_TYPES.VARIANT,
        targetGranularity,
        source,
        productId: variant.productId,
        variantId: variant.id,
        targetIdentity: `VARIANT:${variant.id}`,
        ordinal: ordinal + index,
        filterHash,
        beforeValues: {
          title: variant.title ?? null,
          sku: variant.sku ?? null,
          barcode: variant.barcode ?? null,
          price: variant.price?.toString?.() ?? null,
          compareAtPrice: variant.compareAtPrice?.toString?.() ?? null,
          inventoryQuantity: variant.inventoryQuantity ?? null,
          inventoryItemId: variant.inventoryItemId ?? null,
          inventoryPolicy: variant.inventoryPolicy ?? null,
          taxable: variant.taxable ?? null,
          taxCode: variant.taxCode ?? null,
          cost: variant.cost?.toString?.() ?? null,
          tracked: variant.tracked ?? null,
          physicalProduct: variant.physicalProduct ?? null,
          option1Value: variant.option1Value ?? null,
          option2Value: variant.option2Value ?? null,
          option3Value: variant.option3Value ?? null,
          weight: variant.weight ?? null,
          weightUnit: variant.weightUnit ?? null,
        },
      })),
      skipDuplicates: true,
    });

    totalInserted += variants.length;
    ordinal += variants.length;
    cursorId = variants[variants.length - 1].id;
  }

  return totalInserted;
}

export async function freezeTargetSnapshot({
  ownerType,
  ownerId,
  shop,
  where,
  mirrorBatchId,
  filterHash,
  targetType = "PRODUCT",
  targetGranularity = null,
  explicitVariantIds = [],
  returnStats = false,
  source = null,
  db = db,
}) {
  if (!ownerType || !ownerId || !shop || !mirrorBatchId) {
    throw new Error("ownerType, ownerId, shop, and mirrorBatchId are required for snapshot freeze");
  }
  if (!filterHash) {
    throw new Error("FILTER_HASH_REQUIRED");
  }

  const resolvedGranularity = normalizeTargetGranularity(
    targetGranularity,
    targetType === TARGET_TYPES.VARIANT
      ? TARGET_GRANULARITIES.VARIANT
      : TARGET_GRANULARITIES.PRODUCT,
  );

  await db.targetSnapshot.deleteMany({
    where: { shop, ownerType, ownerId },
  });

  let insertedCount = 0;
  let attemptedInsertCount = 0;
  if (targetType === TARGET_TYPES.PRODUCT) {
    insertedCount = await freezeProductTargetSnapshot({
      ownerType,
      ownerId,
      shop,
      where,
      mirrorBatchId,
      filterHash,
      targetGranularity: resolvedGranularity,
      source,
      db,
    });
    attemptedInsertCount = Number(insertedCount);
  } else if (targetType === TARGET_TYPES.VARIANT) {
    insertedCount = await freezeVariantTargetSnapshot({
      ownerType,
      ownerId,
      shop,
      productWhere: where,
      mirrorBatchId,
      filterHash,
      targetGranularity: resolvedGranularity,
      explicitVariantIds,
      source,
      db,
    });
    attemptedInsertCount = Number(insertedCount);
  } else {
    throw new Error(`Unsupported targetType for freeze: ${targetType}`);
  }

  if (!returnStats) {
    return insertedCount;
  }

  const finalSnapshotCount = await db.targetSnapshot.count({
    where: { shop, ownerType, ownerId, mirrorBatchId },
  });
  return {
    resolvedCount: null,
    attemptedInsertCount,
    insertedCount,
    existingDuplicateCount: Math.max(attemptedInsertCount - insertedCount, 0),
    finalSnapshotCount,
  };
}

function buildCanonicalTargetIdentity(target = {}) {
  if (target.targetType === "PRODUCT") {
    if (!target.productId || target.variantId) {
      throw new Error("INVALID_PRODUCT_TARGET");
    }

    return `PRODUCT:${canonicalizeTargetId(target.productId, "PRODUCT")}`;
  }

  if (target.targetType === "VARIANT") {
    if (!target.productId || !target.variantId) {
      throw new Error("INVALID_VARIANT_TARGET");
    }

    return `VARIANT:${canonicalizeTargetId(target.variantId, "VARIANT")}`;
  }

  throw new Error("UNSUPPORTED_TARGET_TYPE");
}

export async function freezeExplicitTargetSnapshot({
  ownerType,
  ownerId,
  shop,
  mirrorBatchId,
  filterHash,
  targetGranularity = null,
  targets = [],
  returnStats = false,
  source = null,
  db = db,
}) {
  if (!ownerType || !ownerId || !shop || !mirrorBatchId) {
    throw new Error("ownerType, ownerId, shop, and mirrorBatchId are required for explicit snapshot freeze");
  }
  if (!filterHash) {
    throw new Error("FILTER_HASH_REQUIRED");
  }

  await db.targetSnapshot.deleteMany({
    where: { shop, ownerType, ownerId },
  });

  if (!Array.isArray(targets) || !targets.length) {
    if (!returnStats) return 0;
    return {
      resolvedCount: 0,
      attemptedInsertCount: 0,
      insertedCount: 0,
      existingDuplicateCount: 0,
      finalSnapshotCount: 0,
    };
  }

  const rows = targets.map((target, index) => {
    if (!target?.targetType || !target?.productId) {
      throw new Error(`Invalid explicit target snapshot row: ${JSON.stringify(target)}`);
    }

    const canonicalIdentity = buildCanonicalTargetIdentity(target);

    if (target.targetIdentity && target.targetIdentity !== canonicalIdentity) {
      throw new Error("TARGET_IDENTITY_MISMATCH");
    }

    return {
      ownerType,
      ownerId,
      shop,
      mirrorBatchId,
      targetType: target.targetType,
      targetGranularity: normalizeTargetGranularity(
        targetGranularity || target.targetGranularity,
        target.targetType,
      ),
      source,
      productId: canonicalizeTargetId(target.productId, "PRODUCT"),
      variantId: target.variantId ? canonicalizeTargetId(target.variantId, "VARIANT") : null,
      targetIdentity: canonicalIdentity,
      ordinal: index,
      filterHash,
      beforeValues: target.beforeValues || null,
    };
  });

  const BATCH_SIZE = 1000;
  let inserted = 0;
  const attemptedInsertCount = rows.length;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const result = await db.targetSnapshot.createMany({
      data: rows.slice(i, i + BATCH_SIZE),
      skipDuplicates: true,
    });
    inserted += result.count;
  }

  if (!returnStats) {
    return inserted;
  }
  const finalSnapshotCount = await db.targetSnapshot.count({
    where: { shop, ownerType, ownerId, mirrorBatchId },
  });
  return {
    resolvedCount: rows.length,
    attemptedInsertCount,
    insertedCount: inserted,
    existingDuplicateCount: Math.max(attemptedInsertCount - inserted, 0),
    finalSnapshotCount,
  };
}

export async function getFrozenTargetProductIds({
  ownerType,
  ownerId,
  shop,
  mirrorBatchId,
  filterHash = null,
  limit = 500,
  cursorOrdinal = null,
}) {
  if (!mirrorBatchId) {
    throw new Error("mirrorBatchId is required to read frozen product targets");
  }
  const rows = await db.targetSnapshot.findMany({
    where: {
      ownerType,
      ownerId,
      shop,
      mirrorBatchId,
      ...(filterHash ? { filterHash } : {}),
      targetType: "PRODUCT",
      ...(cursorOrdinal !== null ? { ordinal: { gt: cursorOrdinal } } : {}),
    },
    orderBy: { ordinal: "asc" },
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  return {
    rows: pageRows,
    lastOrdinal: pageRows.length ? pageRows[pageRows.length - 1].ordinal : null,
    hasMore,
  };
}

export async function getFrozenTargetVariantIds({
  ownerType,
  ownerId,
  shop,
  mirrorBatchId,
  filterHash = null,
  limit = 500,
  cursorOrdinal = null,
}) {
  if (!mirrorBatchId) {
    throw new Error("mirrorBatchId is required to read frozen variant targets");
  }
  const rows = await db.targetSnapshot.findMany({
    where: {
      ownerType,
      ownerId,
      shop,
      mirrorBatchId,
      ...(filterHash ? { filterHash } : {}),
      targetType: "VARIANT",
      ...(cursorOrdinal !== null ? { ordinal: { gt: cursorOrdinal } } : {}),
    },
    orderBy: { ordinal: "asc" },
    take: limit + 1,
  });
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  return {
    rows: pageRows,
    lastOrdinal: pageRows.length ? pageRows[pageRows.length - 1].ordinal : null,
    hasMore,
  };
}

export async function markPreviewExecutionMismatch({
  shop,
  ownerType,
  ownerId,
  previewCount,
  frozenCount,
}) {
  await recordMirrorAnomaly({
    shop,
    severity: MIRROR_ANOMALY_SEVERITY.CRITICAL,
    type: "preview_execution_mismatch",
    entityType: ownerType,
    entityId: ownerId,
    message: `Preview count ${previewCount} differed from frozen execution count ${frozenCount}`,
    details: {
      previewCount,
      frozenCount,
    },
  });
}

