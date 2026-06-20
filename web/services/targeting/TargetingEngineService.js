import { db as repositoryDb } from "../../repositories/repositoryDb.js";
import crypto from "crypto";
import { adaptLegacyFilterParamsToAst } from "./adapters/legacyFilterParamsAdapter.js";
import { normalizeFilterAst } from "./normalize/filterAstNormalizer.js";
import { validateFilterAstOrThrow } from "./validate/filterAstValidator.js";
import {
  validateMutationIntentPreflight,
  validateBlastRadiusRisk,
} from "./validate/mutationIntentPreflightValidator.js";
import { assertQueryShapeGuardrails } from "./validate/queryShapeGuardrails.js";
import { compileFilterAst } from "./compile/compileFilterAst.js";
import { compileRelationAwareAstWhereSql } from "./compile/relationAwareSqlResolver.js";
import {
  enforceMirrorScope,
  enforceMirrorScopeSql,
} from "./enforceMirrorScope.js";
import { hashFilterAst } from "./hashFilterAst.js";
import { getTargetingVersionBundle } from "./versioning.js";
import { TargetingValidationError } from "./errors/TargetingValidationError.js";
import { getFieldSpecOrThrow } from "./registry/fieldRegistry.js";
import {
  TARGET_GRANULARITIES,
  TARGET_SNAPSHOT_OWNER_TYPES,
  TARGETING_MODES,
  TARGET_TYPES,
} from "./constants.js";
import {
  getTargetingFeatureFlags,
  isEngineV2EnabledForFlow,
} from "./featureFlags.js";
import {
  computeTargetSnapshotChecksum,
  resolveCanonicalTarget,
  getActiveMirrorBatchId,
  freezeTargetSnapshot,
} from "../productService/productTargetingService.js";
import { assertMirrorSafeForTargeting } from "../mirrorHealthService.js";

const db = repositoryDb;

const OWNER_MODEL_MAP = Object.freeze({
  [TARGET_SNAPSHOT_OWNER_TYPES.EDIT_HISTORY]: "editHistory",
  [TARGET_SNAPSHOT_OWNER_TYPES.EXPORT_JOB]: "exportJob",
  [TARGET_SNAPSHOT_OWNER_TYPES.SCHEDULED_EXPORT_RUN]: "scheduledExportRun",
  [TARGET_SNAPSHOT_OWNER_TYPES.RECURRING_EDIT_RUN]: "recurringEditRun",
  [TARGET_SNAPSHOT_OWNER_TYPES.RECURRING_EDIT]: "recurringEdit",
  [TARGET_SNAPSHOT_OWNER_TYPES.AUTOMATIC_PRODUCT_RULE]: "automaticProductRule",
  [TARGET_SNAPSHOT_OWNER_TYPES.AUTOMATIC_PRODUCT_RULE_RUN]:
    "automaticProductRuleRun",
});

function resolveInputAst({
  filterAst,
  legacyFilterParams,
  targetGranularity,
  source,
}) {
  if (filterAst) return filterAst;
  return adaptLegacyFilterParamsToAst({
    filterParams: legacyFilterParams || [],
    targetGranularity,
    source,
  });
}

function countFilterNodes(node) {
  if (!node || typeof node !== "object") return 0;
  const rules = Array.isArray(node.rules) ? node.rules : [];
  const groups = Array.isArray(node.groups) ? node.groups : [];
  return (
    rules.length +
    groups.reduce((sum, child) => sum + countFilterNodes(child), 0)
  );
}

function collectPredicateFields(node, acc = new Set()) {
  if (!node || typeof node !== "object") return acc;
  if (node.nodeType === "group") {
    const children = Array.isArray(node.children) ? node.children : [];
    children.forEach((child) => collectPredicateFields(child, acc));
    return acc;
  }
  if (node.nodeType === "predicate" && node.field) {
    acc.add(String(node.field));
  }
  return acc;
}

function collectPredicates(node, acc = []) {
  if (!node || typeof node !== "object") return acc;
  if (node.nodeType === "group") {
    const children = Array.isArray(node.children) ? node.children : [];
    children.forEach((child) => collectPredicates(child, acc));
    return acc;
  }
  if (node.nodeType === "predicate") {
    acc.push(node);
  }
  return acc;
}

function hasRelationFieldPredicates(ast) {
  const predicates = collectPredicates(ast?.root, []);
  return predicates.some((predicate) => {
    const spec = getFieldSpecOrThrow(predicate.field);
    return String(spec.pathKind || "scalar") === "relation";
  });
}

function hasNodeWithNot(node) {
  if (!node || typeof node !== "object") return false;
  if (node.not === true) return true;
  if (node.nodeType === "group") {
    return (Array.isArray(node.children) ? node.children : []).some((child) =>
      hasNodeWithNot(child)
    );
  }
  return false;
}

function hasGroupLogic(node, logic) {
  if (!node || typeof node !== "object") return false;
  if (node.nodeType === "group") {
    if (
      String(node.logic || "").toUpperCase() ===
      String(logic || "").toUpperCase()
    )
      return true;
    return (Array.isArray(node.children) ? node.children : []).some((child) =>
      hasGroupLogic(child, logic)
    );
  }
  return false;
}

function collectPredicateModels(ast) {
  const predicates = collectPredicates(ast?.root, []);
  const models = new Set();
  for (const predicate of predicates) {
    const spec = getFieldSpecOrThrow(predicate.field);
    const model = String(spec.model || "");
    if (model) models.add(model);
  }
  return models;
}

function shouldRunTargetingParity({ freeze, normalizedFilterAst }) {
  if (!freeze) return false;
  const predicates = collectPredicates(normalizedFilterAst?.root, []);
  if (!predicates.length) return false;
  const hasRelation = predicates.some(
    (p) => String(getFieldSpecOrThrow(p.field).pathKind || "") === "relation"
  );
  const hasVariant = predicates.some(
    (p) => String(getFieldSpecOrThrow(p.field).model || "") === "Variant"
  );
  const hasProduct = predicates.some(
    (p) => String(getFieldSpecOrThrow(p.field).model || "") === "Product"
  );
  const hasOr = hasGroupLogic(normalizedFilterAst?.root, "OR");
  const hasNot = hasNodeWithNot(normalizedFilterAst?.root);
  return (
    hasRelation || hasVariant || (hasProduct && hasVariant) || hasOr || hasNot
  );
}

function buildTargetingParityError({
  shop,
  mirrorBatchId,
  canonicalResult,
  alternateResult,
  filterHash,
}) {
  const error = new Error("TARGETING_PARITY_MISMATCH");
  error.code = "TARGETING_PARITY_MISMATCH";
  error.meta = {
    shop,
    mirrorBatchId,
    previewCount: Number(canonicalResult?.count || 0),
    alternateCount: Number(alternateResult?.count || 0),
    previewChecksum: String(canonicalResult?.checksum || ""),
    alternateChecksum: String(alternateResult?.checksum || ""),
    previewFirstIds: canonicalResult?.firstIds || [],
    alternateFirstIds: alternateResult?.firstIds || [],
    previewLastIds: canonicalResult?.lastIds || [],
    alternateLastIds: alternateResult?.lastIds || [],
    filterFingerprint: filterHash || null,
  };
  return error;
}

async function computeOrderedTargetIdentityDigestFromSql({
  db,
  targetType,
  whereSql,
  params,
}) {
  const PAGE_SIZE = 2000;
  const firstIds = [];
  const tailIds = [];
  const hash = crypto.createHash("sha256");
  let count = 0;
  let cursorProductId = null;
  let cursorVariantId = null;

  const targetIdentityExpr =
    targetType === "VARIANT"
      ? `('VARIANT:' || v."id") AS "targetIdentity"`
      : `('PRODUCT:' || p."id") AS "targetIdentity"`;
  const productExpr = targetType === "VARIANT" ? `v."productId"` : `p."id"`;
  const variantExpr = targetType === "VARIANT" ? `v."id"` : `NULL`;
  const baseFrom =
    targetType === "VARIANT"
      ? `FROM "Variant" v
       INNER JOIN "Product" p
         ON p."shop" = v."shop"
        AND p."mirrorBatchId" = v."mirrorBatchId"
        AND p."id" = v."productId"
       WHERE v."shop" = $1 AND v."mirrorBatchId" = $2 AND (${whereSql})`
      : `FROM "Product" p
       WHERE p."shop" = $1 AND p."mirrorBatchId" = $2 AND (${whereSql})`;

  while (true) {
    const cursorClause =
      targetType === "VARIANT"
        ? cursorVariantId
          ? ` AND (${productExpr} > $${
              params.length + 1
            } OR (${productExpr} = $${
              params.length + 1
            } AND ${variantExpr} > $${params.length + 2}))`
          : ""
        : cursorProductId
        ? ` AND ${productExpr} > $${params.length + 1}`
        : "";
    const orderBy =
      targetType === "VARIANT"
        ? `ORDER BY ${productExpr} ASC, ${variantExpr} ASC`
        : `ORDER BY ${productExpr} ASC`;
    const sql = `
      SELECT ${productExpr} AS "productId", ${variantExpr} AS "variantId", ${targetIdentityExpr}
      ${baseFrom}
      ${cursorClause}
      ${orderBy}
      LIMIT $${
        params.length +
        (targetType === "VARIANT"
          ? cursorVariantId
            ? 3
            : 1
          : cursorProductId
          ? 2
          : 1)
      }
    `;
    const bindParams =
      targetType === "VARIANT"
        ? cursorVariantId
          ? [...params, cursorProductId, cursorVariantId, PAGE_SIZE]
          : [...params, PAGE_SIZE]
        : cursorProductId
        ? [...params, cursorProductId, PAGE_SIZE]
        : [...params, PAGE_SIZE];
    const rows = await db.$queryRawUnsafe(sql, ...bindParams);
    if (!rows?.length) break;
    for (const row of rows) {
      const identity = String(row?.targetIdentity || "").trim();
      if (!identity) continue;
      count += 1;
      if (firstIds.length < 20) firstIds.push(identity);
      tailIds.push(identity);
      if (tailIds.length > 20) tailIds.shift();
      hash.update(identity);
      hash.update("\n");
    }
    const last = rows[rows.length - 1];
    cursorProductId = String(last?.productId || "");
    cursorVariantId =
      targetType === "VARIANT" ? String(last?.variantId || "") : null;
    if (rows.length < PAGE_SIZE) break;
  }

  return {
    count,
    checksum: hash.digest("hex"),
    firstIds,
    lastIds: tailIds,
  };
}

function buildTargetingExplain({
  normalizedAst,
  compiled,
  targetGranularity,
  mirrorBatchId,
  estimatedTargetCount,
  versions,
}) {
  const fieldsUsed = [...collectPredicateFields(normalizedAst?.root)];
  const joinsUsed = [];
  if (
    compiled?.targetModel === "Variant" ||
    fieldsUsed.some((field) => field.toLowerCase().includes("variant"))
  ) {
    joinsUsed.push("Variant");
  }
  const antiJoinsUsed = fieldsUsed.some((field) =>
    field.toLowerCase().includes("collection")
  )
    ? ["Collection"]
    : [];
  return {
    normalizedAst,
    fieldsUsed,
    joinsUsed,
    antiJoinsUsed,
    targetGranularity,
    mirrorBatchId,
    estimatedTargetCount: Number(estimatedTargetCount || 0),
    compilerVersion: versions?.targetingCompilerVersion || null,
  };
}

function hashValues(values = []) {
  const hash = crypto.createHash("sha256");
  for (const value of values) {
    hash.update(String(value || ""));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function getOrderedSampleIds({
  sampleProducts = [],
  sampleVariants = [],
} = {}) {
  const ids = [];
  for (const row of Array.isArray(sampleProducts) ? sampleProducts : []) {
    ids.push(`PRODUCT:${String(row?.id || "")}`);
  }
  for (const row of Array.isArray(sampleVariants) ? sampleVariants : []) {
    ids.push(`VARIANT:${String(row?.id || "")}`);
  }
  return ids;
}

async function computeTargetTypeDistribution({
  db,
  shop,
  ownerType,
  ownerId,
  mirrorBatchId,
}) {
  const [productCount, variantCount] = await Promise.all([
    db.targetSnapshot.count({
      where: {
        shop,
        ownerType,
        ownerId,
        mirrorBatchId,
        targetType: TARGET_TYPES.PRODUCT,
      },
    }),
    db.targetSnapshot.count({
      where: {
        shop,
        ownerType,
        ownerId,
        mirrorBatchId,
        targetType: TARGET_TYPES.VARIANT,
      },
    }),
  ]);

  return {
    PRODUCT: Number(productCount || 0),
    VARIANT: Number(variantCount || 0),
  };
}

async function computeTargetTypeChecksum({
  db,
  shop,
  ownerType,
  ownerId,
  mirrorBatchId,
  targetType,
}) {
  const PAGE_SIZE = 2000;
  let cursorOrdinal = null;
  const values = [];
  while (true) {
    const rows = await db.targetSnapshot.findMany({
      where: {
        shop,
        ownerType,
        ownerId,
        mirrorBatchId,
        targetType,
        ...(cursorOrdinal !== null ? { ordinal: { gt: cursorOrdinal } } : {}),
      },
      select: { ordinal: true, targetIdentity: true, id: true },
      orderBy: [{ ordinal: "asc" }, { id: "asc" }],
      take: PAGE_SIZE,
    });
    if (!rows.length) break;
    for (const row of rows) {
      values.push(row.targetIdentity);
    }
    cursorOrdinal = rows[rows.length - 1].ordinal;
    if (rows.length < PAGE_SIZE) break;
  }
  return hashValues(values);
}

function getTargetingStatementTimeoutMs({ flow, freeze }) {
  if (!freeze) return 10_000;
  if (String(flow || "").toUpperCase() === "EXPORT") return 120_000;
  return 60_000;
}

async function withTargetingStatementTimeout(db, timeoutMs) {
  if (!db || typeof db.$executeRaw !== "function") return;
  try {
    await db.$executeRaw`SET LOCAL statement_timeout = ${`${Number(
      timeoutMs
    )}ms`}`;
  } catch (_error) {
    // SET LOCAL requires transaction scope in Postgres; ignore when unavailable.
  }
}

function isStatementTimeoutError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "").toLowerCase();
  return (
    code === "57014" ||
    message.includes("statement timeout") ||
    message.includes("canceling statement")
  );
}

function buildFreezeKey({
  shop,
  ownerType,
  ownerId,
  mirrorBatchId,
  filterHash,
  targetGranularity,
}) {
  return [
    String(shop || ""),
    String(ownerType || ""),
    String(ownerId || ""),
    String(mirrorBatchId || ""),
    String(filterHash || ""),
    String(targetGranularity || ""),
  ].join(":");
}

async function evaluateBroadTargetSet({
  shop,
  mirrorBatchId,
  normalizedFilterAst,
  resolvedCount,
}) {
  const nodeCount = countFilterNodes(
    normalizedFilterAst?.root || normalizedFilterAst
  );
  const totalInBatch = await db.product.count({
    where: { shop, mirrorBatchId },
  });
  const ratio =
    totalInBatch > 0 ? Number(resolvedCount) / Number(totalInBatch) : 0;
  const isBroad =
    nodeCount === 0 || (Number(resolvedCount) >= 1000 && ratio >= 0.8);
  return {
    requiresConfirmation: isBroad,
    reason: isBroad ? "BROAD_TARGET_SET" : null,
    targetCount: Number(resolvedCount || 0),
    coverageRatio: ratio,
    totalInBatch,
    nodeCount,
  };
}

function assertCanonicalAstForFreeze({
  freeze,
  filterAst,
  legacyFilterParams,
  allowLegacyFilterParams = false,
}) {
  if (!freeze) return;
  if (filterAst) return;
  if (allowLegacyFilterParams === true) return;

  if (Array.isArray(legacyFilterParams) && legacyFilterParams.length > 0) {
    throw new TargetingValidationError(
      "Canonical filterAst is required for new writes in freeze flows",
      { code: "CANONICAL_AST_REQUIRED" }
    );
  }
}

function assertAstInputAllowed({ filterAst, flags }) {
  if (!filterAst) return;
  if (flags.ENABLE_TARGETING_AST_INPUT) return;
  throw new TargetingValidationError("AST input is disabled by feature flag", {
    code: "TARGETING_AST_INPUT_DISABLED",
  });
}

function assertLegacyAdapterAllowed({
  filterAst,
  legacyFilterParams,
  freeze,
  allowLegacyFilterParams,
  flags,
}) {
  if (filterAst) return;
  if (!Array.isArray(legacyFilterParams) || legacyFilterParams.length === 0)
    return;

  if (!flags.ENABLE_TARGETING_LEGACY_ADAPTER_READONLY) return;
  if (freeze && allowLegacyFilterParams !== true) {
    throw new TargetingValidationError(
      "Legacy filterParams adapter is read-only; filterAst is required for writes",
      { code: "LEGACY_FILTER_ADAPTER_READONLY" }
    );
  }
}

function normalizeAndValidate({
  filterAst = null,
  legacyFilterParams = null,
  targetGranularity = "PRODUCT",
  source = "MANUAL_PREVIEW",
  strictValidation = true,
}) {
  const inputAst = resolveInputAst({
    filterAst,
    legacyFilterParams,
    targetGranularity,
    source,
  });
  const normalizedFilterAst = normalizeFilterAst(inputAst);
  const effectiveGranularity =
    normalizedFilterAst?.options?.targetGranularity || targetGranularity;

  if (strictValidation) {
    validateFilterAstOrThrow(normalizedFilterAst, {
      targetGranularity: effectiveGranularity,
      source,
    });
  }

  return {
    filterAst: inputAst,
    normalizedFilterAst,
    targetGranularity: effectiveGranularity,
  };
}

function compileWithScope({
  normalizedFilterAst,
  targetGranularity,
  source,
  shop,
  mirrorBatchId,
  dialect = "db",
}) {
  const compiled = compileFilterAst(normalizedFilterAst, {
    dialect,
    context: {
      targetGranularity,
      productVariantMode: "ANY",
      source,
    },
  });

  if (dialect === "db") {
    return {
      ...compiled,
      where: enforceMirrorScope({
        shop,
        mirrorBatchId,
        where: compiled.where,
      }),
    };
  }

  if (dialect === "sql") {
    const scopedSql = enforceMirrorScopeSql({
      shop,
      mirrorBatchId,
      sqlText: compiled.sql?.text,
      params: compiled.sql?.params || [],
    });
    return {
      ...compiled,
      sql: scopedSql,
    };
  }

  throw new TargetingValidationError("Unsupported compile dialect", {
    code: "UNSUPPORTED_COMPILE_DIALECT",
    meta: { dialect },
  });
}

async function persistTargetingMetadata({
  ownerType,
  ownerId,
  payload,
  mirrorBatchId,
  resolvedAt,
  targetCount,
  resolvedWhere = null,
  targetingModeOverride = null,
  targetingSnapshotMetaOverride = null,
  persistVersions = true,
  freezeKey = null,
  freezeStats = null,
  mutationIntent = null,
  db = repositoryDb,
}) {
  const modelName = OWNER_MODEL_MAP[ownerType];
  if (!modelName || !db[modelName]) return;

  const baseSnapshotMeta = {
    astVersion: payload.versions.filterAstVersion,
    compilerVersion: payload.versions.targetingCompilerVersion,
    fieldRegistryVersion: payload.versions.fieldRegistryVersion,
    operatorRegistryVersion: payload.versions.operatorRegistryVersion,
    targetGranularity: payload.targetGranularity,
    shop: payload.shop,
    mirrorBatchId,
    targetCount,
    filterHash: payload.filterHash,
    normalizedAst: payload.normalizedFilterAst,
    source: payload.source,
    resolvedAt,
    freezeKey,
    freezeStats: freezeStats || null,
    snapshotChecksum: freezeStats?.snapshotChecksum || null,
    mutationIntent: mutationIntent || null,
  };

  const data = {
    filterAst: payload.filterAst,
    normalizedFilterAst: payload.normalizedFilterAst,
    targetingSnapshotMeta: {
      ...baseSnapshotMeta,
      ...(targetingSnapshotMetaOverride || {}),
    },
    targetingMode: targetingModeOverride || "STATIC",
    targetGranularity: payload.targetGranularity,
    targetingCompilerVersion: persistVersions
      ? payload.versions.targetingCompilerVersion
      : null,
    fieldRegistryVersion: persistVersions
      ? payload.versions.fieldRegistryVersion
      : null,
    operatorRegistryVersion: persistVersions
      ? payload.versions.operatorRegistryVersion
      : null,
    filterHash: payload.filterHash,
    targetResolvedAt: resolvedAt,
  };
  if (ownerType === "EXPORT_JOB") {
    data.targetMirrorBatchId = mirrorBatchId;
    data.filterQuery = JSON.stringify(resolvedWhere || {});
  }
  if (ownerType === "EDIT_HISTORY") {
    data.targetMirrorBatchId = mirrorBatchId;
    data.queryFilter = JSON.stringify(resolvedWhere || {});
  }

  const result = await db[modelName].updateMany({
    where: { id: ownerId, shop: payload.shop },
    data,
  });
  if (Number(result?.count || 0) !== 1) {
    throw new TargetingValidationError("TARGETING_OWNER_SHOP_SCOPE_MISMATCH", {
      code: "TARGETING_OWNER_SHOP_SCOPE_MISMATCH",
      meta: {
        ownerType,
        ownerId,
        shop: payload.shop,
      },
    });
  }
}

async function resolveAndMaybeFreeze({
  flow,
  shop,
  source,
  targetType = "PRODUCT",
  targetGranularity = "PRODUCT",
  filterAst = null,
  legacyFilterParams = null,
  queryParams = {},
  sampleLimit = 20,
  ownerType = null,
  ownerId = null,
  freeze = false,
  maxTargetCount = null,
  allowLegacyFilterParams = false,
  targetingModeOverride = null,
  targetingSnapshotMetaOverride = null,
  mutationIntent = null,
  requireBroadTargetConfirmation = false,
  confirmBroadTarget = false,
  db = repositoryDb,
}) {
  const flags = getTargetingFeatureFlags();
  await assertMirrorSafeForTargeting(shop, { purpose: flow });

  assertAstInputAllowed({ filterAst, flags });
  assertLegacyAdapterAllowed({
    filterAst,
    legacyFilterParams,
    freeze,
    allowLegacyFilterParams,
    flags,
  });

  if (freeze && (!ownerType || !ownerId)) {
    throw new TargetingValidationError(
      "ownerType and ownerId are required when freeze=true",
      {
        code: "OWNER_REQUIRED_FOR_FREEZE",
      }
    );
  }

  // Canonical AST requests cannot safely use the legacy resolver: that path
  // only understands legacyFilterParams and would lose the filter hash.
  if (!isEngineV2EnabledForFlow(flags, flow) && !filterAst) {
    const legacyAst =
      Array.isArray(legacyFilterParams) && legacyFilterParams.length
        ? adaptLegacyFilterParamsToAst({
            filterParams: legacyFilterParams,
            targetGranularity,
            source,
          })
        : null;
    const legacyFilterHash = legacyAst
      ? hashFilterAst(normalizeFilterAst(legacyAst))
      : null;
    const resolved = await resolveCanonicalTarget({
      shop,
      targetType,
      filterParams: Array.isArray(legacyFilterParams) ? legacyFilterParams : [],
      queryParams,
      sampleLimit,
      freeze: false,
    });

    let frozenCount = null;
    if (freeze) {
      frozenCount = await freezeTargetSnapshot({
        ownerType,
        ownerId,
        shop,
        source,
        where: resolved.where,
        mirrorBatchId: resolved.mirrorBatchId,
        filterHash:
          legacyFilterHash ||
          `legacy:${ownerType || "UNKNOWN"}:${ownerId || "UNKNOWN"}`,
        targetType,
        targetGranularity,
        db,
      });
      const snapshotChecksum = await computeTargetSnapshotChecksum({
        ownerType,
        ownerId,
        shop,
        mirrorBatchId: resolved.mirrorBatchId,
        db,
      });

      const modelName = OWNER_MODEL_MAP[ownerType];
      if (modelName && db[modelName]) {
        const resolvedAt = new Date();
        await db[modelName]
          .updateMany({
            where: { id: ownerId, shop },
            data: {
              filterHash: legacyFilterHash,
              targetGranularity: String(
                targetGranularity || "PRODUCT"
              ).toUpperCase(),
              targetResolvedAt: resolvedAt,
              targetingSnapshotMeta: {
                shop,
                source,
                mirrorBatchId: resolved.mirrorBatchId,
                targetCount: frozenCount,
                filterHash: legacyFilterHash,
                snapshotChecksum,
                resolvedAt,
                legacyEngine: true,
              },
              ...(ownerType === "EXPORT_JOB"
                ? {
                    targetMirrorBatchId: resolved.mirrorBatchId,
                    filterQuery: JSON.stringify(resolved.where || {}),
                  }
                : {}),
              ...(ownerType === "EDIT_HISTORY"
                ? {
                    targetMirrorBatchId: resolved.mirrorBatchId,
                    queryFilter: JSON.stringify(resolved.where || {}),
                  }
                : {}),
            },
          })
          .catch(() => {});
      }
    }

    return {
      flow,
      mirrorBatchId: resolved.mirrorBatchId,
      where: resolved.where,
      count: resolved.count,
      frozenCount,
      sampleProducts: resolved.sampleProducts || [],
      sampleVariants: resolved.sampleVariants || [],
      pagination: resolved.pagination || null,
      filterHash: legacyFilterHash,
      filterAst: null,
      normalizedFilterAst: null,
      targetGranularity: String(targetGranularity || "PRODUCT").toUpperCase(),
      targetModel: null,
      orderBy: null,
      versions: getTargetingVersionBundle(),
    };
  }

  assertCanonicalAstForFreeze({
    freeze,
    filterAst,
    legacyFilterParams,
    allowLegacyFilterParams,
  });

  const mirrorBatchId = await getActiveMirrorBatchId(shop, {
    purpose: freeze ? "EXECUTE" : "PREVIEW",
  });

  const normalized = normalizeAndValidate({
    filterAst,
    legacyFilterParams,
    targetGranularity,
    source,
    strictValidation: flags.ENABLE_TARGETING_STRICT_VALIDATION,
  });
  validateMutationIntentPreflight({
    mutationIntent,
    targetGranularity: normalized.targetGranularity,
    source,
    normalizedFilterAst: normalized.normalizedFilterAst,
  });
  const queryShape = assertQueryShapeGuardrails(normalized.normalizedFilterAst);
  const filterHash = hashFilterAst(normalized.normalizedFilterAst);
  const hasRelationPredicates = hasRelationFieldPredicates(
    normalized.normalizedFilterAst
  );
  const shouldRunParity = shouldRunTargetingParity({
    freeze,
    normalizedFilterAst: normalized.normalizedFilterAst,
  });
  const compiled = hasRelationPredicates
    ? {
        where: null,
        targetModel: targetType === "VARIANT" ? "Variant" : "Product",
        targetGranularity: normalized.targetGranularity,
        orderBy: [{ id: "asc" }],
      }
    : compileWithScope({
        normalizedFilterAst: normalized.normalizedFilterAst,
        targetGranularity: normalized.targetGranularity,
        source,
        shop,
        mirrorBatchId,
        dialect: "db",
      });

  const whereWithoutScope = compiled.where?.AND?.[0] || compiled.where;
  const timeoutMs = getTargetingStatementTimeoutMs({ flow, freeze });
  await withTargetingStatementTimeout(db, timeoutMs);
  let resolved;
  let paritySqlText = null;
  let paritySqlParams = null;
  try {
    if (hasRelationPredicates) {
      const targetModel = targetType === "VARIANT" ? "Variant" : "Product";
      const { whereSql, params } = compileRelationAwareAstWhereSql(
        normalized.normalizedFilterAst,
        {
          targetType,
          targetModel,
          targetGranularity: normalized.targetGranularity,
          shop,
          mirrorBatchId,
        }
      );
      paritySqlText = whereSql;
      paritySqlParams = params;
      if (targetType === "PRODUCT") {
        const countRows = await db.$queryRawUnsafe(
          `SELECT COUNT(*)::bigint AS count
           FROM "Product" p
           WHERE p."shop" = $1 AND p."mirrorBatchId" = $2 AND (${whereSql})`,
          ...params
        );
        const sampleRows = await db.$queryRawUnsafe(
          `SELECT p."id", p."title", p."status", p."productType", p."vendor", p."totalInventory",
                  p."featuredImageUrl", p."categoryName", p."handle", p."templateSuffix",
                  p."variantCount", p."visibleOnlineStore"
           FROM "Product" p
           WHERE p."shop" = $1 AND p."mirrorBatchId" = $2 AND (${whereSql})
           ORDER BY p."id" ASC
           LIMIT $${params.length + 1}`,
          ...params,
          Number(sampleLimit || 20)
        );
        resolved = {
          mirrorBatchId,
          where: null,
          count: Number(countRows?.[0]?.count || 0),
          sampleProducts: sampleRows || [],
          sampleVariants: [],
          pagination: null,
        };
      } else {
        const countRows = await db.$queryRawUnsafe(
          `SELECT COUNT(*)::bigint AS count
           FROM "Variant" v
           INNER JOIN "Product" p
             ON p."shop" = v."shop"
            AND p."mirrorBatchId" = v."mirrorBatchId"
            AND p."id" = v."productId"
           WHERE v."shop" = $1 AND v."mirrorBatchId" = $2 AND (${whereSql})`,
          ...params
        );
        const sampleRows = await db.$queryRawUnsafe(
          `SELECT v."id", v."productId", v."title", v."sku", v."barcode", v."price",
                  v."compareAtPrice", v."inventoryQuantity", p."title" AS "productTitle"
           FROM "Variant" v
           INNER JOIN "Product" p
             ON p."shop" = v."shop"
            AND p."mirrorBatchId" = v."mirrorBatchId"
            AND p."id" = v."productId"
           WHERE v."shop" = $1 AND v."mirrorBatchId" = $2 AND (${whereSql})
           ORDER BY v."id" ASC
           LIMIT $${params.length + 1}`,
          ...params,
          Number(sampleLimit || 20)
        );
        resolved = {
          mirrorBatchId,
          where: null,
          count: Number(countRows?.[0]?.count || 0),
          sampleProducts: [],
          sampleVariants: sampleRows || [],
          pagination: null,
        };
      }
    } else {
      const parityCompiled = compileWithScope({
        normalizedFilterAst: normalized.normalizedFilterAst,
        targetGranularity: normalized.targetGranularity,
        source,
        shop,
        mirrorBatchId,
        dialect: "sql",
      });
      paritySqlText = parityCompiled.sql?.text || null;
      paritySqlParams = parityCompiled.sql?.params || null;
      resolved = await resolveCanonicalTarget({
        shop,
        targetType,
        filterParams: [],
        explicitWhere: whereWithoutScope,
        queryParams,
        sampleLimit,
        freeze: false,
      });
    }
  } catch (error) {
    if (isStatementTimeoutError(error)) {
      throw new TargetingValidationError(
        "Targeting query timed out. Narrow the filter and retry.",
        { code: "TARGETING_QUERY_TIMEOUT" }
      );
    }
    throw error;
  }
  if (shouldRunParity && paritySqlText && Array.isArray(paritySqlParams)) {
    const canonicalSampleIds = getOrderedSampleIds({
      sampleProducts: resolved?.sampleProducts || [],
      sampleVariants: resolved?.sampleVariants || [],
    });
    const alternateResult = await computeOrderedTargetIdentityDigestFromSql({
      db,
      targetType,
      whereSql: paritySqlText,
      params: paritySqlParams,
    });
    const canonicalResult = {
      count: Number(resolved?.count || 0),
      checksum: hashValues(canonicalSampleIds),
      firstIds: canonicalSampleIds.slice(0, 20),
      lastIds: canonicalSampleIds.slice(-20),
    };
    if (
      Number(canonicalResult.count) !== Number(alternateResult.count) ||
      JSON.stringify(canonicalResult.firstIds) !==
        JSON.stringify(
          alternateResult.firstIds.slice(0, canonicalResult.firstIds.length)
        )
    ) {
      throw buildTargetingParityError({
        shop,
        mirrorBatchId: resolved.mirrorBatchId,
        canonicalResult,
        alternateResult,
        filterHash,
      });
    }
  }
  const explain = buildTargetingExplain({
    normalizedAst: normalized.normalizedFilterAst,
    compiled,
    targetGranularity: normalized.targetGranularity,
    mirrorBatchId: resolved.mirrorBatchId,
    estimatedTargetCount: resolved.count,
    versions: getTargetingVersionBundle(),
  });

  const broadTargetAssessment = await evaluateBroadTargetSet({
    shop,
    mirrorBatchId: resolved.mirrorBatchId,
    normalizedFilterAst: normalized.normalizedFilterAst,
    resolvedCount: resolved.count,
  });
  const blastRadiusAssessment = validateBlastRadiusRisk({
    mutationIntent,
    targetCount: Number(resolved.count || 0),
    totalCatalogCount: Number(broadTargetAssessment.totalInBatch || 0),
  });
  if (
    requireBroadTargetConfirmation &&
    broadTargetAssessment.requiresConfirmation &&
    !confirmBroadTarget
  ) {
    throw new TargetingValidationError("BROAD_TARGET_SET", {
      code: "BROAD_TARGET_SET",
      meta: {
        requiresConfirmation: true,
        reason: "BROAD_TARGET_SET",
        targetCount: Number(resolved.count),
      },
    });
  }

  let frozenCount = null;
  let freezeStats = null;
  const sampleIds = getOrderedSampleIds({
    sampleProducts: resolved?.sampleProducts || [],
    sampleVariants: resolved?.sampleVariants || [],
  });
  const sampleChecksum = hashValues(sampleIds);
  let targetTypeDistribution = null;
  let productTargetChecksum = null;
  let variantTargetChecksum = null;
  if (
    Number.isFinite(Number(maxTargetCount)) &&
    Number(maxTargetCount) > 0 &&
    Number(resolved.count) > Number(maxTargetCount)
  ) {
    throw new TargetingValidationError("TARGET_COUNT_EXCEEDS_PLAN_LIMIT", {
      code: "TARGET_COUNT_EXCEEDS_PLAN_LIMIT",
      meta: {
        count: Number(resolved.count),
        maxTargetCount: Number(maxTargetCount),
        flow,
        shop,
      },
    });
  }

  if (freeze) {
    const freezeKey = buildFreezeKey({
      shop,
      ownerType,
      ownerId,
      mirrorBatchId: resolved.mirrorBatchId,
      filterHash,
      targetGranularity: normalized.targetGranularity,
    });
    if (typeof db?.$queryRaw === "function") {
      const lockKey = `target-freeze:${shop}:${ownerType}:${ownerId}`;
      const rows = await db.$queryRaw`
        SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) AS locked
      `;
      if (!rows?.[0]?.locked) {
        throw new TargetingValidationError(
          "Target freeze is already in progress",
          {
            code: "TARGET_FREEZE_LOCK_CONFLICT",
          }
        );
      }
    }
    const modelName = OWNER_MODEL_MAP[ownerType];
    let reusedSnapshot = null;
    if (modelName && db[modelName]) {
      const existingOwner = await db[modelName].findFirst({
        where: { id: ownerId, shop },
        select: {
          targetingSnapshotMeta: true,
        },
      });
      const existingSnapshotMeta = existingOwner?.targetingSnapshotMeta || {};
      const existingFreezeKey = existingSnapshotMeta?.freezeKey || null;
      const existingSnapshotCount = await db.targetSnapshot.count({
        where: {
          shop,
          ownerType,
          ownerId,
          mirrorBatchId: resolved.mirrorBatchId,
        },
      });
      if (
        existingFreezeKey === freezeKey &&
        Number(existingSnapshotCount || 0) > 0 &&
        String(existingSnapshotMeta?.mirrorBatchId || "") ===
          String(resolved.mirrorBatchId || "") &&
        String(existingSnapshotMeta?.filterHash || "") ===
          String(filterHash || "")
      ) {
        reusedSnapshot = {
          resolvedCount: Number(resolved.count),
          attemptedInsertCount: 0,
          insertedCount: 0,
          existingDuplicateCount: 0,
          finalSnapshotCount: Number(existingSnapshotCount || 0),
          reused: true,
        };
      }
    }

    if (hasRelationPredicates) {
      await db.targetSnapshot.deleteMany({
        where: { shop, ownerType, ownerId },
      });
      const BATCH_SIZE = 1000;
      let cursor = null;
      let ordinal = 0;
      let inserted = 0;
      const { whereSql, params } = compileRelationAwareAstWhereSql(
        normalized.normalizedFilterAst,
        {
          targetType,
          targetGranularity: normalized.targetGranularity,
          shop,
          mirrorBatchId: resolved.mirrorBatchId,
        }
      );
      while (true) {
        const cursorClause = cursor
          ? ` AND t."id" > $${params.length + 1}`
          : "";
        const rows = await db.$queryRawUnsafe(
          targetType === "PRODUCT"
            ? `SELECT t."id"
               FROM "Product" t
               WHERE t."shop" = $1 AND t."mirrorBatchId" = $2
                 AND (${whereSql})${cursorClause}
               ORDER BY t."id" ASC
               LIMIT $${params.length + (cursor ? 2 : 1)}`
            : `SELECT t."id"
               FROM "Variant" t
               INNER JOIN "Product" p
                 ON p."shop" = t."shop"
                AND p."mirrorBatchId" = t."mirrorBatchId"
                AND p."id" = t."productId"
               WHERE t."shop" = $1 AND t."mirrorBatchId" = $2
                 AND (${whereSql})${cursorClause}
               ORDER BY t."id" ASC
               LIMIT $${params.length + (cursor ? 2 : 1)}`,
          ...(cursor
            ? [...params, cursor, BATCH_SIZE]
            : [...params, BATCH_SIZE])
        );
        if (!rows?.length) break;
        const ids = rows.map((r) => String(r.id));
        if (targetType === "PRODUCT") {
          const products = await db.product.findMany({
            where: {
              shop,
              mirrorBatchId: resolved.mirrorBatchId,
              id: { in: ids },
            },
            select: {
              id: true,
              title: true,
              status: true,
              vendor: true,
              productType: true,
              handle: true,
            },
            orderBy: { id: "asc" },
          });
          await db.targetSnapshot.createMany({
            data: products.map((p, idx) => ({
              ownerType,
              ownerId,
              shop,
              mirrorBatchId: resolved.mirrorBatchId,
              targetType: TARGET_TYPES.PRODUCT,
              targetGranularity: normalized.targetGranularity,
              source,
              productId: p.id,
              variantId: null,
              targetIdentity: `PRODUCT:${p.id}`,
              ordinal: ordinal + idx,
              filterHash,
              beforeValues: {
                title: p.title ?? null,
                status: p.status ?? null,
                vendor: p.vendor ?? null,
                productType: p.productType ?? null,
                handle: p.handle ?? null,
              },
            })),
            skipDuplicates: true,
          });
          inserted += products.length;
          ordinal += products.length;
        } else {
          const variants = await db.variant.findMany({
            where: {
              shop,
              mirrorBatchId: resolved.mirrorBatchId,
              id: { in: ids },
            },
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
          });
          await db.targetSnapshot.createMany({
            data: variants.map((v, idx) => ({
              ownerType,
              ownerId,
              shop,
              mirrorBatchId: resolved.mirrorBatchId,
              targetType: TARGET_TYPES.VARIANT,
              targetGranularity: normalized.targetGranularity,
              source,
              productId: v.productId,
              variantId: v.id,
              targetIdentity: `VARIANT:${v.id}`,
              ordinal: ordinal + idx,
              filterHash,
              beforeValues: {
                title: v.title ?? null,
                sku: v.sku ?? null,
                barcode: v.barcode ?? null,
                price: v.price?.toString?.() ?? null,
                compareAtPrice: v.compareAtPrice?.toString?.() ?? null,
                inventoryQuantity: v.inventoryQuantity ?? null,
                inventoryItemId: v.inventoryItemId ?? null,
                inventoryPolicy: v.inventoryPolicy ?? null,
                taxable: v.taxable ?? null,
                taxCode: v.taxCode ?? null,
                cost: v.cost?.toString?.() ?? null,
                tracked: v.tracked ?? null,
                physicalProduct: v.physicalProduct ?? null,
                option1Value: v.option1Value ?? null,
                option2Value: v.option2Value ?? null,
                option3Value: v.option3Value ?? null,
                weight: v.weight ?? null,
                weightUnit: v.weightUnit ?? null,
              },
            })),
            skipDuplicates: true,
          });
          inserted += variants.length;
          ordinal += variants.length;
        }
        cursor = ids[ids.length - 1];
        if (rows.length < BATCH_SIZE) break;
      }
      const finalSnapshotCount = await db.targetSnapshot.count({
        where: {
          shop,
          ownerType,
          ownerId,
          mirrorBatchId: resolved.mirrorBatchId,
        },
      });
      freezeStats = {
        resolvedCount: Number(resolved.count || 0),
        attemptedInsertCount: inserted,
        insertedCount: inserted,
        existingDuplicateCount: 0,
        finalSnapshotCount,
      };
    } else {
      freezeStats =
        reusedSnapshot ||
        (await freezeTargetSnapshot({
          ownerType,
          ownerId,
          shop,
          source,
          where: resolved.where,
          mirrorBatchId: resolved.mirrorBatchId,
          filterHash,
          targetType,
          targetGranularity: normalized.targetGranularity,
          returnStats: true,
          db,
        }));
    }
    freezeStats.resolvedCount = Number(resolved.count);
    freezeStats.snapshotChecksum = await computeTargetSnapshotChecksum({
      ownerType,
      ownerId,
      shop,
      mirrorBatchId: resolved.mirrorBatchId,
      db,
    });
    frozenCount = Number(freezeStats.finalSnapshotCount || 0);
    if (freezeStats.finalSnapshotCount !== Number(resolved.count)) {
      throw new TargetingValidationError("TARGET_SNAPSHOT_COUNT_MISMATCH", {
        code: "TARGET_SNAPSHOT_COUNT_MISMATCH",
        meta: {
          resolvedCount: Number(resolved.count),
          attemptedInsertCount: Number(freezeStats.attemptedInsertCount || 0),
          insertedCount: Number(freezeStats.insertedCount || 0),
          existingDuplicateCount: Number(
            freezeStats.existingDuplicateCount || 0
          ),
          finalSnapshotCount: Number(freezeStats.finalSnapshotCount || 0),
          shop,
          ownerType,
          ownerId,
          mirrorBatchId: resolved.mirrorBatchId,
        },
      });
    }
    targetTypeDistribution = await computeTargetTypeDistribution({
      db,
      shop,
      ownerType,
      ownerId,
      mirrorBatchId: resolved.mirrorBatchId,
    });
    const distributionTotal =
      Number(targetTypeDistribution.PRODUCT || 0) +
      Number(targetTypeDistribution.VARIANT || 0);
    if (distributionTotal !== Number(freezeStats.finalSnapshotCount || 0)) {
      throw new TargetingValidationError("TARGET_TYPE_DISTRIBUTION_MISMATCH", {
        code: "TARGET_TYPE_DISTRIBUTION_MISMATCH",
        meta: {
          distributionTotal,
          finalSnapshotCount: Number(freezeStats.finalSnapshotCount || 0),
          targetTypeDistribution,
          shop,
          ownerType,
          ownerId,
          mirrorBatchId: resolved.mirrorBatchId,
        },
      });
    }
    productTargetChecksum = await computeTargetTypeChecksum({
      db,
      shop,
      ownerType,
      ownerId,
      mirrorBatchId: resolved.mirrorBatchId,
      targetType: TARGET_TYPES.PRODUCT,
    });
    variantTargetChecksum = await computeTargetTypeChecksum({
      db,
      shop,
      ownerType,
      ownerId,
      mirrorBatchId: resolved.mirrorBatchId,
      targetType: TARGET_TYPES.VARIANT,
    });

    await persistTargetingMetadata({
      ownerType,
      ownerId,
      mirrorBatchId: resolved.mirrorBatchId,
      resolvedAt: new Date(),
      targetCount: frozenCount,
      resolvedWhere: resolved.where,
      targetingModeOverride,
      targetingSnapshotMetaOverride,
      persistVersions: flags.ENABLE_TARGETING_PERSIST_VERSIONS,
      freezeKey,
      freezeStats,
      mutationIntent: {
        ...(mutationIntent || {}),
        blastRadiusAssessment: blastRadiusAssessment || null,
      },
      db,
      payload: {
        ...normalized,
        shop,
        source,
        filterHash,
        versions: getTargetingVersionBundle(),
      },
    });
  }

  if (
    !freeze &&
    Array.isArray(legacyFilterParams) &&
    legacyFilterParams.length > 0
  ) {
    try {
      const legacyResolved = await resolveCanonicalTarget({
        shop,
        targetType,
        filterParams: legacyFilterParams,
        queryParams,
        sampleLimit,
        freeze: false,
      });
      if (legacyResolved.count !== resolved.count) {
        console.warn("[TARGETING_SHADOW_MISMATCH]", {
          flow,
          shop,
          source,
          v2Count: resolved.count,
          legacyCount: legacyResolved.count,
        });
      }
    } catch (_err) {
      // shadow mode comparison should never block user flow
    }
  }

  return {
    flow,
    mirrorBatchId: resolved.mirrorBatchId,
    where: resolved.where,
    count: resolved.count,
    frozenCount,
    freezeStats,
    sampleProducts: resolved.sampleProducts || [],
    sampleVariants: resolved.sampleVariants || [],
    pagination: resolved.pagination || null,
    broadTargetAssessment,
    blastRadiusAssessment,
    explain,
    queryShape,
    filterHash,
    snapshotChecksum: freezeStats?.snapshotChecksum || null,
    parity: {
      count: Number(resolved.count || 0),
      sampleChecksum,
      freezeChecksum: freezeStats?.snapshotChecksum || null,
      productTargetChecksum: productTargetChecksum || null,
      variantTargetChecksum: variantTargetChecksum || null,
      targetTypeDistribution: targetTypeDistribution || null,
      mirrorBatchId: resolved.mirrorBatchId,
      filterHash,
    },
    filterAst: normalized.filterAst,
    normalizedFilterAst: normalized.normalizedFilterAst,
    targetGranularity: normalized.targetGranularity,
    targetModel: compiled.targetModel,
    orderBy: compiled.orderBy,
    versions: getTargetingVersionBundle(),
  };
}

export const TargetingEngineService = {
  prepareTargetingPayload({
    filterAst = null,
    legacyFilterParams = null,
    targetGranularity = "PRODUCT",
    shop,
    mirrorBatchId,
    dialect = "db",
    source = "MANUAL_PREVIEW",
    applyMirrorScope = true,
  }) {
    const flags = getTargetingFeatureFlags();
    assertAstInputAllowed({ filterAst, flags });
    assertLegacyAdapterAllowed({
      filterAst,
      legacyFilterParams,
      freeze: false,
      allowLegacyFilterParams: true,
      flags,
    });

    const normalized = normalizeAndValidate({
      filterAst,
      legacyFilterParams,
      targetGranularity,
      source,
      strictValidation: flags.ENABLE_TARGETING_STRICT_VALIDATION,
    });
    const filterHash = hashFilterAst(normalized.normalizedFilterAst);
    let compiled = compileFilterAst(normalized.normalizedFilterAst, {
      dialect,
      context: {
        targetGranularity: normalized.targetGranularity,
        productVariantMode: "ANY",
        source,
      },
    });

    if (dialect === "db" && applyMirrorScope) {
      compiled = {
        ...compiled,
        where: enforceMirrorScope({
          shop,
          mirrorBatchId,
          where: compiled.where,
        }),
      };
    }

    if (dialect === "sql" && applyMirrorScope) {
      compiled = {
        ...compiled,
        sql: enforceMirrorScopeSql({
          shop,
          mirrorBatchId,
          sqlText: compiled.sql?.text,
          params: compiled.sql?.params || [],
        }),
      };
    }

    return {
      filterAst: normalized.filterAst,
      normalizedFilterAst: normalized.normalizedFilterAst,
      filterHash,
      compiled,
      targetGranularity: normalized.targetGranularity,
      versions: getTargetingVersionBundle(),
    };
  },

  async resolvePreviewTargets(input) {
    return resolveAndMaybeFreeze({
      flow: "PREVIEW",
      freeze: false,
      ...input,
    });
  },

  async resolveAndFreezeExecutionTargets(input) {
    return resolveAndMaybeFreeze({
      flow: "EXECUTION",
      freeze: true,
      allowLegacyFilterParams: false,
      requireBroadTargetConfirmation:
        input?.requireBroadTargetConfirmation === true,
      confirmBroadTarget: input?.confirmBroadTarget === true,
      ...input,
    });
  },

  async resolveAndFreezeExportTargets(input) {
    return resolveAndMaybeFreeze({
      flow: "EXPORT",
      freeze: true,
      allowLegacyFilterParams: false,
      targetingModeOverride:
        input?.targetingModeOverride || TARGETING_MODES.DYNAMIC_AT_RUN,
      targetingSnapshotMetaOverride: input?.targetingSnapshotMetaOverride || {
        source: input?.source || "EXPORT",
        semantics: TARGETING_MODES.DYNAMIC_AT_RUN,
      },
      ...input,
    });
  },

  async resolveAndFreezeScheduledTargets(input) {
    return resolveAndMaybeFreeze({
      flow: "SCHEDULED",
      freeze: true,
      allowLegacyFilterParams: false,
      targetingModeOverride: TARGETING_MODES.STATIC_AT_SCHEDULE_CREATE,
      targetingSnapshotMetaOverride: {
        source: input?.source || "SCHEDULED",
        semantics: TARGETING_MODES.STATIC_AT_SCHEDULE_CREATE,
      },
      ...input,
    });
  },

  async resolveAndFreezeRecurringRunTargets(input) {
    const allowLegacyForRecurring =
      !input?.filterAst && Array.isArray(input?.legacyFilterParams);
    return resolveAndMaybeFreeze({
      flow: "RECURRING",
      freeze: true,
      allowLegacyFilterParams: allowLegacyForRecurring,
      targetingModeOverride: TARGETING_MODES.DYNAMIC_AT_RUN,
      targetingSnapshotMetaOverride: {
        source: input?.source || "RECURRING",
        semantics: TARGETING_MODES.DYNAMIC_AT_RUN,
      },
      ...input,
    });
  },
};
