import crypto from "crypto";
import { prisma } from "../../config/database.js";
import {
  getFrozenTargetProductIds,
  getFrozenTargetVariantIds,
} from "./productTargetingService.js";
import { getUpdatedProducts } from "../../helpers/productBulkOperationHelpers/productUpdateHandler.js";
import {
  buildProductInclude,
  hydrateMissingVariantsForProducts,
} from "./helpers/bulkEditPreviewHelpers.js";

function mergeRuleLevelChangesForTarget(ruleChanges = []) {
  const list = Array.isArray(ruleChanges) ? ruleChanges.filter(Boolean) : [];
  if (!list.length) return null;

  const base = list[0];
  const mergedProductFieldChanges = [];
  const mergedVariantById = new Map();

  for (const change of list) {
    const productFields = Array.isArray(change?.productFieldChanges)
      ? change.productFieldChanges
      : [];
    mergedProductFieldChanges.push(...productFields);

    const variantFields = Array.isArray(change?.variantFieldChanges)
      ? change.variantFieldChanges
      : [];
    for (const variantChange of variantFields) {
      const variantId = variantChange?.variantId;
      if (!variantId) continue;
      const bucket = mergedVariantById.get(variantId) || {
        variantId,
        variantTitle: variantChange?.variantTitle || null,
        selectedOptions: Array.isArray(variantChange?.selectedOptions)
          ? variantChange.selectedOptions
          : [],
        changes: [],
      };
      const entries = Array.isArray(variantChange?.changes) ? variantChange.changes : [];
      bucket.changes.push(...entries);
      mergedVariantById.set(variantId, bucket);
    }
  }

  const mergedVariantFieldChanges = Array.from(mergedVariantById.values());
  const mergedScope = mergedVariantFieldChanges.length > 0
    ? "variant"
    : mergedProductFieldChanges.length > 0
      ? "product"
      : base.scope;

  return {
    ...base,
    scope: mergedScope,
    productFieldChanges: mergedProductFieldChanges,
    variantFieldChanges: mergedVariantFieldChanges,
  };
}

export class BulkEditExecutionPreparationService {
  constructor({ session }) {
    this.session = session;
  }

  async prepareBulkOperation({ historyId }) {
    const history = await prisma.editHistory.findUnique({
      where: { id: historyId },
      select: {
        shop: true,
        batch: true,
        rules: true,
        targetMirrorBatchId: true,
        targetSnapshotCount: true,
        executionIdentity: true,
      },
    });

    if (!history) {
      throw new Error("Edit history not found");
    }

    const rules = Array.isArray(history.rules) ? history.rules.filter(Boolean) : [];
    if (!rules.length) {
      throw new Error("Edit rules not found");
    }

    const limit = history.batch?.size || 75;
    const cursorOrdinal = Number.isInteger(history.batch?.lastProductId)
      ? history.batch.lastProductId
      : null;
    const targetType = String(history.batch?.automaticRuleTargetType || "PRODUCT").toUpperCase();
    const isAutomaticRuleExecution = Boolean(history.batch?.automaticRuleTargetType);
    if (isAutomaticRuleExecution && !history.targetMirrorBatchId) {
      throw new Error("Automatic rule execution requires targetMirrorBatchId on edit history");
    }
    const retryFailedOnly = Boolean(history.batch?.retryFailedOnly);
    const retryTargetIdentities = Array.isArray(history.batch?.retryTargetIdentities)
      ? history.batch.retryTargetIdentities.filter(Boolean)
      : [];
    const retryCursorIndex = Number.isInteger(history.batch?.retryCursorIndex)
      ? history.batch.retryCursorIndex
      : 0;

    let rows = [];
    let lastProductId = null;
    let hasMore = false;
    let nextRetryCursorIndex = retryCursorIndex;

    if (retryFailedOnly) {
      const pageIdentities = retryTargetIdentities.slice(retryCursorIndex, retryCursorIndex + limit);
      hasMore = retryCursorIndex + pageIdentities.length < retryTargetIdentities.length;
      nextRetryCursorIndex = retryCursorIndex + pageIdentities.length;
      if (pageIdentities.length > 0) {
        rows = await prisma.targetSnapshot.findMany({
          where: {
            ownerType: "EDIT_HISTORY",
            ownerId: historyId,
            shop: history.shop,
            ...(history.targetMirrorBatchId ? { mirrorBatchId: history.targetMirrorBatchId } : {}),
            targetIdentity: { in: pageIdentities },
          },
          orderBy: [{ ordinal: "asc" }, { id: "asc" }],
          select: {
            productId: true,
            variantId: true,
            targetType: true,
            ordinal: true,
          },
        });
        lastProductId = rows.length > 0 ? rows[rows.length - 1].ordinal : null;
      }
    } else {
      const frozenTargetPage = targetType === "VARIANT"
        ? await getFrozenTargetVariantIds({
          ownerType: "EDIT_HISTORY",
          ownerId: historyId,
          shop: history.shop,
          mirrorBatchId: history.targetMirrorBatchId,
          limit,
          cursorOrdinal,
        })
        : await getFrozenTargetProductIds({
          ownerType: "EDIT_HISTORY",
          ownerId: historyId,
          shop: history.shop,
          mirrorBatchId: history.targetMirrorBatchId,
          limit,
          cursorOrdinal,
        });
      rows = frozenTargetPage.rows;
      lastProductId = frozenTargetPage.lastOrdinal;
      hasMore = frozenTargetPage.hasMore;
    }

    if (!rows.length) {
      return {
        formattedProducts: "",
        changes: [],
        lastProductId: null,
        hasMore: false,
        nextRetryCursorIndex,
        batchId: crypto
          .createHash("sha1")
          .update(`${history.executionIdentity || historyId}:${cursorOrdinal ?? "start"}:empty`)
          .digest("hex"),
        batchTargetCount: 0,
      };
    }
    if (isAutomaticRuleExecution) {
      const hasMismatch = rows.some((row) => String(row?.targetType || "").toUpperCase() !== targetType);
      if (hasMismatch) {
        throw new Error(`Automatic rule snapshot targetType mismatch: expected ${targetType}`);
      }
    }

    const fields = rules.map((rule) => rule.field).filter(Boolean);
    const include = buildProductInclude(fields);

    const safeInclude = include?.variants && history.targetMirrorBatchId
      ? { variants: { where: { mirrorBatchId: history.targetMirrorBatchId } } }
      : include;
    const orderedIds = [...new Set(rows.map((row) => row.productId).filter(Boolean))];
    const variantIdsByProduct = rows.reduce((accumulator, row) => {
      if (row?.targetType !== "VARIANT" || !row.productId || !row.variantId) {
        return accumulator;
      }
      const bucket = accumulator.get(row.productId) || new Set();
      bucket.add(row.variantId);
      accumulator.set(row.productId, bucket);
      return accumulator;
    }, new Map());

    let products = await prisma.product.findMany({
      where: {
        shop: history.shop,
        id: { in: orderedIds },
        ...(history.targetMirrorBatchId
          ? { mirrorBatchId: history.targetMirrorBatchId }
          : {}),
      },
      ...(safeInclude ? { include: safeInclude } : {}),
    });

    if (safeInclude?.variants) {
      products = await hydrateMissingVariantsForProducts(
        products,
        history.shop,
        history.targetMirrorBatchId,
      );
    }

    const productsById = new Map(products.map((product) => [product.id, product]));
    const formattedProducts = [];
    const changes = [];
    const batchId = crypto
      .createHash("sha1")
      .update(
        `${history.executionIdentity || historyId}:${cursorOrdinal ?? "start"}:${lastProductId}:${rows.length}`,
      )
      .digest("hex");

    for (const productId of orderedIds) {
      const rawProduct = productsById.get(productId);
      if (!rawProduct) {
        continue;
      }

      const product = {
        ...rawProduct,
        descriptionHtml: rawProduct.descriptionHtml ?? null,
        descriptionText: rawProduct.descriptionText ?? null,
        description:
          rawProduct.descriptionHtml ??
          rawProduct.descriptionText ??
          "",
        options: Array.isArray(rawProduct.options)
          ? rawProduct.options
          : Array.isArray(rawProduct.optionsJson)
            ? rawProduct.optionsJson
            : [],
        variants: Array.isArray(rawProduct.variants)
          ? rawProduct.variants.map((variant) => ({
            ...variant,
            selectedOptions: Array.isArray(variant.selectedOptions)
              ? variant.selectedOptions
              : Array.isArray(variant.selectedOptionsJson)
                ? variant.selectedOptionsJson
                : [],
          }))
          : [],
      };
      if (variantIdsByProduct.size > 0) {
        const allowed = variantIdsByProduct.get(product.id);
        product.variants = Array.isArray(product.variants)
          ? product.variants.filter((variant) => allowed?.has(variant.id))
          : [];
      }

      let lastFormattedLine = null;
      const perTargetRuleChanges = [];
      for (const rule of rules) {
        const result = getUpdatedProducts({
          product,
          field: rule.field,
          editType: rule.editOption,
          value: rule.value,
          searchKey: rule.searchKey,
          replaceText: rule.replaceText,
          supportValue: rule.supportValue,
          changes: perTargetRuleChanges,
          historyId,
          shop: history.shop,
          batchId,
        });

        if (result) {
          lastFormattedLine = result;
        }
      }
      if (lastFormattedLine) {
        formattedProducts.push(lastFormattedLine);
      }
      const mergedChange = mergeRuleLevelChangesForTarget(perTargetRuleChanges);
      if (mergedChange) {
        changes.push(mergedChange);
      }
    }

    return {
      formattedProducts: formattedProducts.join("\n"),
      changes,
      lastProductId,
      hasMore,
      nextRetryCursorIndex,
      batchId,
      batchTargetCount: rows.length,
    };
  }
}
