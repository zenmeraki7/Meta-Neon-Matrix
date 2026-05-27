import crypto from "crypto";
import { prisma } from "../../config/database.js";
import { TargetingEngineService } from "../targeting/TargetingEngineService.js";
import { computeBlastRadiusRisk } from "../targeting/validate/mutationIntentPreflightValidator.js";
import { getUpdatedProducts } from "../../helpers/productBulkOperationHelpers/productUpdateHandler.js";
import {
  FIELD_TRANSLATIONS,
  hydrateMissingVariantsForProducts,
  isVariantLevelField,
  normalizeField,
  normalizeMirrorProductForPreview,
} from "./helpers/bulkEditPreviewHelpers.js";
import { buildExecutionPlanForEdit } from "./helpers/bulkEditOperationHelpers.js";

export const PREVIEW_VARIANT_SELECT = Object.freeze({
  id: true,
  productId: true,
  mirrorBatchId: true,
  position: true,
  title: true,
  price: true,
  compareAtPrice: true,
  barcode: true,
  sku: true,
  taxable: true,
  inventoryPolicy: true,
  inventoryQuantity: true,
  cost: true,
  requiresShipping: true,
  weight: true,
  weightUnit: true,
  selectedOptionsJson: true,
  selectedOptions: true,
});

export const PREVIEW_PRODUCT_SELECT = Object.freeze({
  id: true,
  title: true,
  descriptionHtml: true,
  descriptionText: true,
  handle: true,
  vendor: true,
  productType: true,
  status: true,
  tags: true,
  optionsJson: true,
  seoTitle: true,
  seoDescription: true,
  categoryId: true,
  categoryName: true,
  collectionsJson: true,
  featuredImageUrl: true,
});

export class ProductBulkPreviewService {
  constructor({ session }) {
    this.session = session;
  }

  async trackEditProducts({
    field,
    editType,
    editValue,
    filterParams,
    searchKey,
    replaceText,
    supportValue,
    filterAst,
    operationKey = null,
    cursor = null,
    limit = 20,
    lang,
    subscription = {},
    actorId = null,
  }) {
    const changes = [];
    field = normalizeField(field);

    const isVariant = isVariantLevelField(field);
    const targetGranularity = isVariant ? "VARIANT" : "PRODUCT";
    const target = await TargetingEngineService.resolvePreviewTargets({
      shop: this.session.shop,
      source: "MANUAL_PREVIEW",
      targetType: targetGranularity === "VARIANT" ? "VARIANT" : "PRODUCT",
      targetGranularity,
      filterAst: filterAst ?? null,
      legacyFilterParams: Array.isArray(filterParams) ? filterParams : [],
      queryParams: { cursor, limit },
      sampleLimit: Number.parseInt(limit, 10) || 20,
    });
    const previewId = crypto.randomUUID();
    await prisma.filterTrack.create({
      data: {
        id: previewId,
        shop: this.session.shop,
        userId: actorId ? String(actorId) : null,
        type: "preview",
        filterParams: Array.isArray(filterParams) ? filterParams : [],
        previewResCount: target.count,
        value: {
          previewId,
          actorId: actorId ? String(actorId) : null,
          normalizedAst: target.normalizedFilterAst,
          filterHash: target.filterHash,
          mirrorBatchId: target.mirrorBatchId,
          targetCount: target.count,
          compilerVersion: target.versions?.targetingCompilerVersion || null,
          registryVersion: {
            fieldRegistryVersion: target.versions?.fieldRegistryVersion || null,
            operatorRegistryVersion: target.versions?.operatorRegistryVersion || null,
          },
        },
        source: "manual_preview",
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    const productLimit = subscription?.limit || 100;
    const planName = subscription?.planName || "Free Plan";
    const isUnlimited = subscription?.isUnlimited || false;

    let subscriptionWarning = null;

    if (!isUnlimited) {
      if (target.count > productLimit) {
        subscriptionWarning = {
          type: "LIMIT_EXCEEDED",
          message: `Your current plan (${planName}) allows editing up to ${productLimit} products. You're trying to edit ${target.count} products. Please upgrade your plan or reduce the number of products.`,
        };
      } else if (target.count > productLimit * 0.8) {
        const remaining = productLimit - target.count;
        subscriptionWarning = {
          type: "APPROACHING_LIMIT",
          message: `You're editing ${target.count} products. Your plan allows ${productLimit} products per edit. ${remaining} products remaining.`,
        };
      }
    }

    const productIds = target.sampleProducts.map((product) => product.id);
    let products = await prisma.product.findMany({
      where: {
        shop: this.session.shop,
        id: { in: productIds },
        ...(target.mirrorBatchId ? { mirrorBatchId: target.mirrorBatchId } : {}),
      },
      select: {
        ...PREVIEW_PRODUCT_SELECT,
        ...(isVariant
          ? {
              variants: {
                where: target.mirrorBatchId
                  ? { mirrorBatchId: target.mirrorBatchId }
                  : undefined,
                select: PREVIEW_VARIANT_SELECT,
              },
            }
          : {}),
      },
    });

    if (isVariant) {
      products = await hydrateMissingVariantsForProducts(
        products,
        this.session.shop,
        target.mirrorBatchId,
      );
    }

    const productMap = new Map(products.map((product) => [product.id, product]));
    const formattedProducts = [];

    for (const targetProduct of target.sampleProducts) {
      const rawProduct = productMap.get(targetProduct.id);
      if (!rawProduct) continue;

      const product = normalizeMirrorProductForPreview(rawProduct);

      const result = getUpdatedProducts({
        product,
        field,
        editType,
        value: editValue,
        changes,
        searchKey,
        replaceText,
        supportValue,
        isTracking: true,
      });

      if (result) {
        formattedProducts.push(result);
      }
    }
    const blastRadiusAssessment = computeBlastRadiusRisk({
      targetCount: Number(target.count || 0),
      totalCatalogCount: Number(target?.broadTargetAssessment?.totalInBatch || 0),
      fieldsEdited: [field].filter(Boolean),
      destructiveNature: String(field || "") === "deleteProducts",
      undoAvailability: String(field || "") !== "deleteProducts",
      verificationMode: "SAMPLE_PLUS_FAILURES",
    });

    const executionPlan = buildExecutionPlanForEdit({
      operationKey,
      shop: this.session.shop,
      planType: "BULK_EDIT",
      rules: [{ field }],
      targetGranularity: target?.targetGranularity || "PRODUCT",
      targetCount: Number(target.count || 0),
      shopPlanLimits: { batchSize: 250 },
    });
    const estimatedDurationClass = executionPlan.estimatedChunks > 100
      ? "XLARGE"
      : executionPlan.estimatedChunks > 40
        ? "LARGE"
        : executionPlan.estimatedChunks > 10
          ? "MEDIUM"
          : "SMALL";
    const warnings = [];
    if (target?.targetGranularity === "VARIANT") {
      warnings.push("This edit affects variant-level data.");
    }
    if (["price", "compareAtPrice", "inventory"].includes(String(field || ""))) {
      warnings.push("Undo is available only for targets with captured before-values.");
    }
    return {
      executionPlan: {
        operationId: executionPlan.operationId,
        shop: executionPlan.shop,
        planType: executionPlan.planType,
        targetType: executionPlan.targetType,
        mutationType: executionPlan.mutationType,
        apiStrategy: executionPlan.apiStrategy,
        estimatedCost: executionPlan.estimatedCost,
        estimatedChunks: executionPlan.estimatedChunks,
        requiresBeforeSnapshot: executionPlan.requiresBeforeSnapshot,
        requiresVerification: executionPlan.requiresVerification,
        supportsUndo: executionPlan.supportsUndo,
        riskLevel: executionPlan.riskLevel,
        path: executionPlan.executionPath,
        batches: executionPlan.estimatedChunks,
        verification: executionPlan.requiresVerification
          ? "SAMPLE_PLUS_FAILURES"
          : "NOT_REQUIRED",
        estimatedDurationClass,
      },
      warnings,
      message: "tracking successful",
      risk: {
        riskLevel: blastRadiusAssessment.riskLevel,
        riskScore: blastRadiusAssessment.riskScore,
        requiredCriticalConfirmation: blastRadiusAssessment.requiredCriticalConfirmation,
      },
      data: {
        preview: formattedProducts,
        targetCount: Number(target.count || 0),
        targetGranularity: target?.targetGranularity || "PRODUCT",
        productCount:
          String(target?.targetGranularity || "PRODUCT").toUpperCase() === "VARIANT"
            ? 0
            : Number(target.count || 0),
        variantCount:
          String(target?.targetGranularity || "PRODUCT").toUpperCase() === "VARIANT"
            ? Number(target.count || 0)
            : 0,
        field: FIELD_TRANSLATIONS?.[field]?.[lang] || field,
        isVariant,
        mirrorBatchId: target.mirrorBatchId,
        previewFingerprint: {
          previewId,
          normalizedAst: target.normalizedFilterAst,
          filterHash: target.filterHash,
          mirrorBatchId: target.mirrorBatchId,
          targetCount: target.count,
          compilerVersion: target.versions?.targetingCompilerVersion || null,
          registryVersion: {
            fieldRegistryVersion: target.versions?.fieldRegistryVersion || null,
            operatorRegistryVersion: target.versions?.operatorRegistryVersion || null,
          },
        },
        requiresConfirmation: target?.broadTargetAssessment?.requiresConfirmation === true,
        riskLevel: blastRadiusAssessment.riskLevel,
        riskScore: blastRadiusAssessment.riskScore,
        requiredCriticalConfirmation: blastRadiusAssessment.requiredCriticalConfirmation,
        blastRadius: blastRadiusAssessment,
        reason: target?.broadTargetAssessment?.reason || null,
        targetCount: Number(target.count || 0),
        pagination: target.pagination,
      },
      subscription: subscriptionWarning ? { warning: subscriptionWarning } : {},
    };
  }
}
