import crypto from "crypto";
import { db } from "../../repositories/repositoryDb.js";
import { TargetingEngineService } from "../targeting/TargetingEngineService.js";
import { computeBlastRadiusRisk } from "../targeting/validate/mutationIntentPreflightValidator.js";
import { getStoreMirrorState } from "../mirrorHealthService.js";
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
  weight: true,
  weightUnit: true,
  selectedOptionsJson: true,
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

function withVariantPreviewGranularity(filterAst) {
  if (!filterAst || typeof filterAst !== "object" || Array.isArray(filterAst)) {
    return filterAst ?? null;
  }

  return {
    ...filterAst,
    options: {
      ...(filterAst.options || {}),
      targetGranularity: "PRODUCT_WITH_MATCHING_VARIANTS",
    },
  };
}

function buildPreviewTargetingError(message = "Refresh product data before previewing this edit.") {
  const error = new Error(message);
  error.code = "TARGETING_REQUIRES_SYNC";
  error.action = "SYNC_PRODUCTS";
  return error;
}

function isSyncRequiredTargetingError(error) {
  const code = String(error?.code || "").toUpperCase();
  return code === "TARGETING_REQUIRES_SYNC" || code === "TARGETING_MIRROR_UNSAFE";
}

function mergeMirrorScope(where, shop, mirrorBatchId) {
  const scoped = where && typeof where === "object" && !Array.isArray(where)
    ? { ...where }
    : {};
  const hasScopedFilter = Object.keys(scoped).length > 0;
  return {
    AND: [
      { shop },
      { mirrorBatchId },
      ...(hasScopedFilter ? [scoped] : []),
    ],
  };
}

function displayPreviewValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value.displayText ?? value.value ?? value.text ?? null;
  }
  return value ?? null;
}

function buildProductOptionsForProductSet(product) {
  return (Array.isArray(product?.options) ? product.options : [])
    .map((option) => ({
      name: option?.name,
      values: (Array.isArray(option?.values) ? option.values : [])
        .map((value) => ({ name: value?.name ?? value }))
        .filter((value) => value.name !== undefined && value.name !== null && value.name !== ""),
    }))
    .filter((option) => option.name);
}

function buildVariantOptionValues(variant) {
  return (Array.isArray(variant?.selectedOptions) ? variant.selectedOptions : [])
    .map((option) => ({
      optionName: option?.name,
      name: option?.value,
    }))
    .filter((option) => option.optionName && option.name !== undefined && option.name !== null);
}

function buildExecutablePreviewRow({
  product,
  variant,
  previewVariant,
  field,
  previewId,
}) {
  const productId = String(product?.id || "").trim();
  const variantId = String(previewVariant?.variantId || previewVariant?.id || variant?.id || "").trim();
  const currentValue = displayPreviewValue(previewVariant?.oldValue);
  const newValue = displayPreviewValue(previewVariant?.newValue);
  const status = String(previewVariant?.status || "READY").toUpperCase();
  const productSet = {
    id: productId,
    productOptions: buildProductOptionsForProductSet(product),
    variants: [
      {
        id: variantId,
        optionValues: buildVariantOptionValues(variant),
        [field]: newValue,
      },
    ],
  };
  const plannedMutation = {
    jsonlRow: JSON.stringify({ productSet }),
    productSet,
    variantFieldChanges: [
      {
        variantId,
        variantTitle: previewVariant?.title || variant?.title || "Default Title",
        changes: [
          {
            field,
            oldValue: currentValue,
            newValue,
          },
        ],
      },
    ],
  };

  return {
    previewId,
    productId,
    variantId,
    productTitle: product?.title || "",
    variantTitle: previewVariant?.title || variant?.title || "Default Title",
    currentValue,
    newValue,
    status,
    warning: previewVariant?.warning || null,
    targetType: "VARIANT",
    targetIdentity: variantId ? `VARIANT:${variantId}` : null,
    beforeValues: {
      field,
      currentValue,
      oldValue: currentValue,
      productTitle: product?.title || "",
      variantTitle: previewVariant?.title || variant?.title || "Default Title",
    },
    plannedMutation,
  };
}

async function resolveBestAvailableMirrorBatchId(shop) {
  const state = await getStoreMirrorState(shop);
  if (state?.activeMirrorBatchId) {
    return {
      mirrorBatchId: state.activeMirrorBatchId,
      mirrorState: state,
    };
  }

  const latestProduct = await db.product.findFirst({
    where: {
      shop,
      mirrorBatchId: { not: null },
    },
    select: {
      mirrorBatchId: true,
    },
    orderBy: {
      updatedAt: "desc",
    },
  });

  if (!latestProduct?.mirrorBatchId) {
    throw buildPreviewTargetingError();
  }

  return {
    mirrorBatchId: latestProduct.mirrorBatchId,
    mirrorState: state || null,
  };
}

export class ProductBulkPreviewService {
  constructor({ session }) {
    this.session = session;
  }

  async resolvePreviewTargetsWithSnapshotFallback({
    field,
    previewFilterAst,
    filterParams,
    cursor,
    page,
    limit,
    isVariant,
  }) {
    try {
      return await TargetingEngineService.resolvePreviewTargets({
        shop: this.session.shop,
        source: "MANUAL_PREVIEW",
        targetType: isVariant ? "VARIANT" : "PRODUCT",
        targetGranularity: isVariant ? "VARIANT" : "PRODUCT",
        filterAst: previewFilterAst ?? null,
        legacyFilterParams: Array.isArray(filterParams) ? filterParams : [],
        queryParams: { cursor, page, limit },
        sampleLimit: Number.parseInt(limit, 10) || 20,
      });
    } catch (error) {
      if (!isSyncRequiredTargetingError(error)) {
        throw error;
      }
      return this.resolvePreviewTargetsFromAvailableSnapshot({
        field,
        previewFilterAst,
        filterParams,
        page,
        limit,
        isVariant,
        originalError: error,
      });
    }
  }

  async resolvePreviewTargetsFromAvailableSnapshot({
    previewFilterAst,
    filterParams,
    page = 1,
    limit = 20,
    isVariant,
    originalError = null,
  }) {
    if (!previewFilterAst && (!Array.isArray(filterParams) || filterParams.length === 0)) {
      throw buildPreviewTargetingError();
    }

    let prepared;
    try {
      prepared = TargetingEngineService.prepareTargetingPayload({
        shop: this.session.shop,
        source: "MANUAL_PREVIEW",
        targetType: isVariant ? "VARIANT" : "PRODUCT",
        targetGranularity: isVariant
          ? "PRODUCT_WITH_MATCHING_VARIANTS"
          : "PRODUCT",
        filterAst: previewFilterAst ?? null,
        legacyFilterParams: Array.isArray(filterParams) ? filterParams : [],
        applyMirrorScope: false,
      });
    } catch (error) {
      const wrapped = buildPreviewTargetingError(
        "This filter cannot be previewed safely. Refresh products or simplify the filter.",
      );
      wrapped.code = "TARGETING_FILTER_UNSUPPORTED";
      wrapped.cause = error;
      throw wrapped;
    }

    const { mirrorBatchId, mirrorState } = await resolveBestAvailableMirrorBatchId(
      this.session.shop,
    );
    const productWhere = mergeMirrorScope(
      prepared?.compiled?.where || {},
      this.session.shop,
      mirrorBatchId,
    );
    const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
    const safeLimit = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 20));

    if (isVariant) {
      const matchingProducts = await db.product.findMany({
        where: productWhere,
        select: {
          id: true,
        },
        orderBy: {
          id: "asc",
        },
      });
      const productIds = matchingProducts.map((product) => product.id);
      const variantWhere = {
        shop: this.session.shop,
        mirrorBatchId,
        productId: productIds.length ? { in: productIds } : "__no_match__",
      };
      const [variantCount, sampleVariants] = await db.$transaction([
        db.variant.count({ where: variantWhere }),
        db.variant.findMany({
          where: variantWhere,
          select: {
            id: true,
            productId: true,
          },
          orderBy: [
            { productId: "asc" },
            { position: "asc" },
            { id: "asc" },
          ],
          skip: (safePage - 1) * safeLimit,
          take: safeLimit,
        }),
      ]);

      console.info("[edit-preview] snapshot fallback", {
        shop: this.session.shop,
        mirrorBatchId,
        mirrorHealthState: mirrorState?.mirrorHealthState || null,
        originalCode: originalError?.code || null,
        matchingProductCount: productIds.length,
        affectedVariantCount: variantCount,
        rowsReturned: sampleVariants.length,
      });

      return {
        flow: "PREVIEW",
        mirrorBatchId,
        where: productWhere,
        count: variantCount,
        matchingProductCount: productIds.length,
        sampleProducts: [],
        sampleVariants,
        pagination: {
          page: safePage,
          limit: safeLimit,
          total: variantCount,
          totalPages: Math.max(1, Math.ceil(variantCount / safeLimit)),
        },
        broadTargetAssessment: {
          requiresConfirmation: false,
          reason: null,
          targetCount: variantCount,
          totalInBatch: productIds.length,
        },
        filterHash: prepared.filterHash,
        filterAst: prepared.filterAst,
        normalizedFilterAst: prepared.normalizedFilterAst,
        targetGranularity: "VARIANT",
        targetModel: "Variant",
        versions: prepared.versions,
      };
    }

    const [productCount, sampleProducts] = await db.$transaction([
      db.product.count({ where: productWhere }),
      db.product.findMany({
        where: productWhere,
        select: {
          id: true,
        },
        orderBy: {
          id: "asc",
        },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
    ]);

    console.info("[edit-preview] snapshot fallback", {
      shop: this.session.shop,
      mirrorBatchId,
      mirrorHealthState: mirrorState?.mirrorHealthState || null,
      originalCode: originalError?.code || null,
      matchingProductCount: productCount,
      rowsReturned: sampleProducts.length,
    });

    return {
      flow: "PREVIEW",
      mirrorBatchId,
      where: productWhere,
      count: productCount,
      sampleProducts,
      sampleVariants: [],
      pagination: {
        page: safePage,
        limit: safeLimit,
        total: productCount,
        totalPages: Math.max(1, Math.ceil(productCount / safeLimit)),
      },
      broadTargetAssessment: {
        requiresConfirmation: false,
        reason: null,
        targetCount: productCount,
        totalInBatch: productCount,
      },
      filterHash: prepared.filterHash,
      filterAst: prepared.filterAst,
      normalizedFilterAst: prepared.normalizedFilterAst,
      targetGranularity: "PRODUCT",
      targetModel: "Product",
      versions: prepared.versions,
    };
  }

  async getPreviewVariantDetails({
    previewId,
    productId,
    page = 1,
    limit = 50,
    actorId = null,
  }) {
    const previewTrack = await db.filterTrack.findFirst({
      where: {
        id: String(previewId),
        shop: this.session.shop,
        type: "preview",
        source: "manual_preview",
      },
      select: {
        value: true,
      },
    });

    const previewValue =
      previewTrack && typeof previewTrack.value === "object" && previewTrack.value
        ? previewTrack.value
        : {};

    if (!previewTrack || !previewValue?.field || !previewValue?.editType) {
      const error = new Error("Preview context not found");
      error.code = "PREVIEW_CONTEXT_NOT_FOUND";
      throw error;
    }

    const field = normalizeField(previewValue.field);
    const isVariant = isVariantLevelField(field);

    const rawProduct = await db.product.findFirst({
      where: {
        shop: this.session.shop,
        id: String(productId),
        ...(previewValue?.mirrorBatchId ? { mirrorBatchId: previewValue.mirrorBatchId } : {}),
      },
      select: {
        ...PREVIEW_PRODUCT_SELECT,
        variants: {
          where: previewValue?.mirrorBatchId
            ? { mirrorBatchId: previewValue.mirrorBatchId }
            : undefined,
          select: PREVIEW_VARIANT_SELECT,
        },
      },
    });

    if (!rawProduct) {
      return {
        previewId: String(previewId),
        productId: String(productId),
        page,
        limit,
        total: 0,
        totalPages: 1,
        rows: [],
        isVariant,
      };
    }

    const [hydratedProduct] = await hydrateMissingVariantsForProducts(
      [rawProduct],
      this.session.shop,
      previewValue?.mirrorBatchId || null,
    );

    const normalizedProduct = normalizeMirrorProductForPreview(hydratedProduct);

    const result = getUpdatedProducts({
      product: normalizedProduct,
      field,
      editType: previewValue.editType,
      value: previewValue.editValue,
      changes: [],
      searchKey: previewValue.searchKey || null,
      replaceText: previewValue.replaceText || null,
      supportValue: previewValue.supportValue ?? null,
      isTracking: true,
    });

    const allVariants = Array.isArray(result?.variants) ? result.variants : [];
    const safeLimit = Math.max(1, Math.min(250, Number(limit) || 50));
    const safePage = Math.max(1, Number(page) || 1);
    const total = allVariants.length;
    const totalPages = Math.max(1, Math.ceil(total / safeLimit));
    const start = (safePage - 1) * safeLimit;
    const rows = allVariants.slice(start, start + safeLimit);

    return {
      previewId: String(previewId),
      productId: String(productId),
      page: safePage,
      limit: safeLimit,
      total,
      totalPages,
      rows,
      isVariant,
    };
  }

  async trackEditProducts({
    field,
    operation = null,
    editType,
    editValue,
    filterParams,
    searchKey,
    replaceText,
    supportValue,
    locationId,
    rounding = "NONE",
    filterAst,
    operationKey = null,
    cursor = null,
    page = 1,
    limit = 20,
    lang,
    subscription = {},
    actorId = null,
  }) {
    const changes = [];
    field = normalizeField(field);

    const isVariant = isVariantLevelField(field);
    const previewFilterAst = isVariant
      ? withVariantPreviewGranularity(filterAst)
      : filterAst;
    const target = await this.resolvePreviewTargetsWithSnapshotFallback({
      field,
      previewFilterAst,
      filterParams,
      cursor,
      page,
      limit,
      isVariant,
    });
    const previewSignatureHash = crypto
      .createHash("sha256")
      .update(JSON.stringify({
        shop: this.session.shop,
        actorId: actorId ? String(actorId) : null,
        field,
        editType,
        editValue,
        searchKey,
        replaceText,
        supportValue,
        locationId: locationId || null,
        filterAst: target.normalizedFilterAst,
        filterHash: target.filterHash,
        mirrorBatchId: target.mirrorBatchId,
        targetCount: Number(target.count || 0),
        cursor: cursor || null,
        page: Number.parseInt(page, 10) || 1,
        limit: Number.parseInt(limit, 10) || 20,
      }))
      .digest("hex");
    const previewSignature = `sig_${previewSignatureHash.slice(0, 12)}`;
    const dedupeWindowMs = Number.parseInt(
      process.env.PREVIEW_DEDUPE_WINDOW_MS || "45000",
      10,
    );
    const dedupeCutoff = new Date(Date.now() - Math.max(0, dedupeWindowMs));
    const existingPreviewTrack = await db.filterTrack.findFirst({
      where: {
        shop: this.session.shop,
        userId: actorId ? String(actorId) : null,
        type: "preview",
        source: "manual_preview",
        searchKey: previewSignatureHash,
        createdAt: { gte: dedupeCutoff },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
      },
    });
    const previewId = existingPreviewTrack?.id || crypto.randomUUID();
    if (existingPreviewTrack?.id) {
      await db.filterTrack.update({
        where: { id: existingPreviewTrack.id },
        data: {
          previewResCount: target.count,
          filterParams: Array.isArray(filterParams) ? filterParams : [],
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
          value: {
            previewId,
            shop: this.session.shop,
            actorId: actorId ? String(actorId) : null,
            owner: {
              type: actorId ? "SHOPIFY_USER" : "SHOP",
              shop: this.session.shop,
              actorId: actorId ? String(actorId) : null,
            },
            field,
            operation,
            editType,
            editValue,
            searchKey: searchKey || null,
            replaceText: replaceText || null,
            supportValue: supportValue ?? null,
            locationId: locationId || null,
            normalizedAst: target.normalizedFilterAst,
            filterHash: target.filterHash,
            mirrorBatchId: target.mirrorBatchId,
            targetCount: target.count,
            compilerVersion: target.versions?.targetingCompilerVersion || null,
            registryVersion: {
              fieldRegistryVersion: target.versions?.fieldRegistryVersion || null,
              operatorRegistryVersion: target.versions?.operatorRegistryVersion || null,
            },
            previewSignature,
            previewSignatureHash,
          },
        },
      });
    } else {
      await db.filterTrack.create({
        data: {
          id: previewId,
          shop: this.session.shop,
          userId: actorId ? String(actorId) : null,
          type: "preview",
          filterParams: Array.isArray(filterParams) ? filterParams : [],
          previewResCount: target.count,
          searchKey: previewSignatureHash,
          value: {
            previewId,
            shop: this.session.shop,
            actorId: actorId ? String(actorId) : null,
            owner: {
              type: actorId ? "SHOPIFY_USER" : "SHOP",
              shop: this.session.shop,
              actorId: actorId ? String(actorId) : null,
            },
            field,
            operation,
            editType,
            editValue,
            searchKey: searchKey || null,
            replaceText: replaceText || null,
            supportValue: supportValue ?? null,
            locationId: locationId || null,
            normalizedAst: target.normalizedFilterAst,
            filterHash: target.filterHash,
            mirrorBatchId: target.mirrorBatchId,
            targetCount: target.count,
            compilerVersion: target.versions?.targetingCompilerVersion || null,
            registryVersion: {
              fieldRegistryVersion: target.versions?.fieldRegistryVersion || null,
              operatorRegistryVersion: target.versions?.operatorRegistryVersion || null,
            },
            previewSignature,
            previewSignatureHash,
          },
          source: "manual_preview",
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      });
    }

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

    const targetSampleVariants = Array.isArray(target.sampleVariants)
      ? target.sampleVariants
      : [];
    const targetSampleVariantIds = new Set(
      targetSampleVariants.map((variant) => String(variant?.id || "")).filter(Boolean),
    );
    const productIds = isVariant
      ? [...new Set(targetSampleVariants.map((variant) => variant.productId).filter(Boolean))]
      : target.sampleProducts.map((product) => product.id);
    const matchingProductCount = isVariant
      ? Number(target.matchingProductCount ?? new Set(targetSampleVariants.map((variant) => String(variant?.productId || "")).filter(Boolean)).size)
      : Number(target.count || 0);
    let products = await db.product.findMany({
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
    const executablePreviewRows = [];

    const orderedPreviewProductIds = isVariant ? productIds : target.sampleProducts.map((product) => product.id);

    for (const productId of orderedPreviewProductIds) {
      const rawProduct = productMap.get(productId);
      if (!rawProduct) continue;

      const product = normalizeMirrorProductForPreview(rawProduct);
      const previewProduct =
        isVariant && targetSampleVariantIds.size
          ? {
              ...product,
              variants: product.variants.filter((variant) =>
                targetSampleVariantIds.has(String(variant?.id || "")),
              ),
            }
          : product;

      const result = getUpdatedProducts({
        product: previewProduct,
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
        if (isVariant && Array.isArray(result?.variants)) {
          const variantById = new Map(
            (Array.isArray(previewProduct?.variants) ? previewProduct.variants : [])
              .map((variant) => [String(variant?.id || variant?._id || "").trim(), variant]),
          );
          for (const previewVariant of result.variants) {
            const variantId = String(previewVariant?.variantId || previewVariant?.id || "").trim();
            if (!variantId) continue;
            executablePreviewRows.push(buildExecutablePreviewRow({
              product: previewProduct,
              variant: variantById.get(variantId) || null,
              previewVariant,
              field,
              previewId,
            }));
          }
        }
      }
    }

    const readyExecutablePreviewRows = executablePreviewRows.filter(
      (row) => String(row?.status || "").toUpperCase() === "READY",
    );
    await db.filterTrack.update({
      where: { id: previewId },
      data: {
        value: {
          previewId,
          shop: this.session.shop,
          actorId: actorId ? String(actorId) : null,
          owner: {
            type: actorId ? "SHOPIFY_USER" : "SHOP",
            shop: this.session.shop,
            actorId: actorId ? String(actorId) : null,
          },
          field,
          operation,
          editType,
          editValue,
          searchKey: searchKey || null,
          replaceText: replaceText || null,
          supportValue: supportValue ?? null,
          locationId: locationId || null,
          rounding,
          normalizedAst: target.normalizedFilterAst,
          filterAst: target.normalizedFilterAst,
          where: target.where || null,
          filterHash: target.filterHash,
          mirrorBatchId: target.mirrorBatchId,
          targetCount: target.count,
          count: readyExecutablePreviewRows.length || Number(target.count || 0),
          matchingProductCount,
          affectedVariantCount:
            String(target?.targetGranularity || "PRODUCT").toUpperCase() === "VARIANT"
              ? Number(target.count || 0)
              : readyExecutablePreviewRows.length,
          targetGranularity: target?.targetGranularity || (isVariant ? "VARIANT" : "PRODUCT"),
          broadTargetAssessment: target?.broadTargetAssessment || null,
          compilerVersion: target.versions?.targetingCompilerVersion || null,
          registryVersion: {
            fieldRegistryVersion: target.versions?.fieldRegistryVersion || null,
            operatorRegistryVersion: target.versions?.operatorRegistryVersion || null,
          },
          previewSignature,
          previewSignatureHash,
          status: "READY",
          rows: executablePreviewRows,
          executableRows: readyExecutablePreviewRows,
          rowsPersisted: executablePreviewRows.length,
          readyRows: readyExecutablePreviewRows.length,
        },
      },
    });

    console.info("[edit-preview] persisted", {
      previewId,
      shop: this.session.shop,
      rowsPersisted: executablePreviewRows.length,
      readyRows: readyExecutablePreviewRows.length,
      affectedVariantCount:
        String(target?.targetGranularity || "PRODUCT").toUpperCase() === "VARIANT"
          ? Number(target.count || 0)
          : readyExecutablePreviewRows.length,
    });

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
        productCount: matchingProductCount,
        matchingProductCount,
        variantCount:
          String(target?.targetGranularity || "PRODUCT").toUpperCase() === "VARIANT"
            ? Number(target.count || 0)
            : 0,
        field: FIELD_TRANSLATIONS?.[field]?.[lang] || field,
        canonicalField: field,
        operation,
        value: editValue,
        rounding,
        isVariant,
        mirrorBatchId: target.mirrorBatchId,
        previewSignature,
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

