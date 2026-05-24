//web/helpers/webhookHelpers/bulkOperations/bulkEdit.js
import axios from "axios";
import readline from "readline";
import {
  getSession,
  getShopOwnerEmailAddress,
} from "../../../utils/sessionHandler.js";
import { productEditConfirmationEmailHTML } from "../../../config/templates/productEditConfirmationTemplate.js";
import { sendEmail } from "../../../utils/emailHelper.js";
import { addbulkUndoJob } from "../../../Jobs/Queues/bulkUndoJob.js";
import { addBulkEditExecuteJob } from "../../../Jobs/Queues/bulkEditExecuteJob.js";
import { clearKeyCaches } from "../../../utils/cacheUtils.js";
import { prisma } from "../../../config/database.js";
import { finalizeRecurringRunFromHistory } from "../../../services/recurringEditExecutionService.js";
import { finalizeAutomaticProductRuleRunFromHistory } from "../../../services/automaticProductRuleExecutionService.js";
import { getActiveMirrorBatchId } from "../../../services/productService/productTargetingService.js";
import { adminGraphqlWithRetry } from "../../../utils/shopifyAdminApi.js";
import { normalizeProductStatus } from "../../../utils/productStatus.js";
import {
  markRepairRequired,
  MIRROR_STALE_REASONS,
} from "../../../services/mirrorHealthService.js";
import { addShopSyncJob } from "../../../Jobs/Queues/shopSyncJob.js";
import { schedulePostMutationMirrorReconciliation } from "../../../services/mirrorReconciliationService.js";
import {
  BULK_EDIT_EXECUTION_STATES,
  BULK_UNDO_STATES,
  appendExecutionError,
  buildExecutionError,
  isTerminalExecutionState,
  isTerminalUndoState,
  normalizeUndoState,
} from "../../../services/bulkEditExecutionStateService.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../../../utils/normalizedStateUtils.js";
import { OPERATION_LIFECYCLE_STATES } from "../../../services/operationLifecycleStateMachine.js";
import {
  beginEditHistoryStage,
  completeEditHistoryStage,
  failEditHistoryStage,
} from "../../../services/operationStageIdempotencyService.js";

async function acquireBulkOperationFinalizeLock(lockKey) {
  const rows = await prisma.$queryRaw`
    SELECT pg_try_advisory_lock(hashtext(${lockKey})) AS locked
  `;

  return Boolean(rows?.[0]?.locked);
}

async function releaseBulkOperationFinalizeLock(lockKey) {
  await prisma.$queryRaw`
    SELECT pg_advisory_unlock(hashtext(${lockKey}))
  `;
}

async function findAutomaticRuleProcessingToken(historyId) {
  if (!historyId) return null;
  const history = await prisma.editHistory.findUnique({
    where: { id: historyId },
    select: { automaticProductRuleRunId: true },
  });
  if (!history?.automaticProductRuleRunId) return null;
  const run = await prisma.automaticProductRuleRun.findUnique({
    where: { id: history.automaticProductRuleRunId },
    select: { processingToken: true },
  });
  return run?.processingToken || null;
}

function asObject(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function hasValue(value) {
  return value !== undefined && value !== null;
}

function preferIncomingOrExisting(incoming, existing) {
  return hasValue(incoming) ? incoming : existing;
}

function preferNonEmptyStringOrExisting(incoming, existing) {
  if (typeof incoming === "string") {
    return incoming.trim() === "" ? existing : incoming;
  }
  return hasValue(incoming) ? incoming : existing;
}

function toNullableFloat(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toNullableInt(value) {
  if (value == null || value === "") return null;
  const num = Number(value);
  return Number.isInteger(num) ? num : null;
}

function toNullableBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value == null || value === "") return null;
  return Boolean(value);
}

function calculateDurationMs(startedAt, completedAt = new Date()) {
  return Math.max(
    new Date(completedAt).getTime() - new Date(startedAt).getTime(),
    0,
  );
}

function pickVerificationSample(rows, max = 100) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length <= max) return list;
  return list.slice(0, max);
}

function isHighRiskVerificationRule(field) {
  return ["deleteProducts", "inventory", "metafield", "metafields", "status"].includes(
    String(field || ""),
  );
}

function isDestructiveVerificationRequired(history, fields = []) {
  const normalizedFields = Array.isArray(fields)
    ? fields.map((field) => String(field || "").trim())
    : [];
  const batch = asObject(history?.batch);
  const executionPlan = asObject(batch.executionPlan);
  const mutationType = String(executionPlan.mutationType || "").toUpperCase();
  const operationKey = String(executionPlan.operationKey || "").toUpperCase();
  if (normalizedFields.includes("deleteProducts")) return true;
  if (operationKey === "PRODUCT_DELETE") return true;
  if (mutationType === "PRODUCTSET" || mutationType === "PRODUCT_SET") return true;
  return false;
}

async function fetchShopifyNodesByIds(session, ids) {
  const chunks = [];
  const allIds = Array.isArray(ids) ? ids.filter(Boolean) : [];
  for (let i = 0; i < allIds.length; i += 100) {
    chunks.push(allIds.slice(i, i + 100));
  }

  const nodes = [];
  for (const chunk of chunks) {
    const response = await adminGraphqlWithRetry({
      session,
      operationName: "bulk-edit-verification-nodes",
      data: {
        query: `#graphql
          query VerifyNodes($ids: [ID!]!) {
            nodes(ids: $ids) {
              __typename
              id
              ... on Product {
                title
                handle
                vendor
                productType
                status
              }
              ... on ProductVariant {
                sku
                barcode
                price
                compareAtPrice
                inventoryQuantity
              }
            }
          }
        `,
        variables: { ids: chunk },
      },
    });
    nodes.push(...(response?.body?.data?.nodes || []));
  }
  return nodes;
}

async function patchMirrorFromVerifiedNodes(history, verifiedNodes = []) {
  const batchId = await getActiveMirrorBatchId(history.shop, {
    purpose: "WEBHOOK_INCREMENTAL",
  }).catch(() => null);
  if (!batchId) return;

  const productNodes = (Array.isArray(verifiedNodes) ? verifiedNodes : []).filter(
    (node) => node?.__typename === "Product" && node?.id,
  );
  const foundProductIds = new Set(productNodes.map((node) => String(node.id)));

  if (productNodes.length > 0) {
    await prisma.$transaction(
      productNodes.map((product) =>
        prisma.product.upsert({
          where: {
            shop_id_mirrorBatchId: {
              shop: history.shop,
              id: String(product.id),
              mirrorBatchId: batchId,
            },
          },
          create: {
            shop: history.shop,
            id: String(product.id),
            mirrorBatchId: batchId,
            title: product.title ?? "",
            handle: product.handle ?? null,
            status: product.status ?? "ACTIVE",
            statusNormalized: normalizeProductStatus(product.status ?? "ACTIVE"),
            productType: product.productType ?? null,
            vendor: product.vendor ?? null,
            tags: [],
          },
          update: {
            title: product.title ?? "",
            handle: product.handle ?? null,
            status: product.status ?? "ACTIVE",
            statusNormalized: normalizeProductStatus(product.status ?? "ACTIVE"),
            productType: product.productType ?? null,
            vendor: product.vendor ?? null,
          },
        }),
      ),
      { maxWait: 10_000, timeout: 60_000 },
    ).catch(() => {});
  }

  const targetProducts = await prisma.targetSnapshot.findMany({
    where: {
      shop: history.shop,
      ownerType: "EDIT_HISTORY",
      ownerId: history.id,
      targetType: "PRODUCT",
      ...(history.targetMirrorBatchId ? { mirrorBatchId: history.targetMirrorBatchId } : {}),
    },
    select: {
      productId: true,
    },
  });
  const deletedProductIds = [...new Set(
    targetProducts
      .map((row) => String(row.productId || "").trim())
      .filter((id) => id && !foundProductIds.has(id)),
  )];
  if (deletedProductIds.length > 0) {
    for (let i = 0; i < deletedProductIds.length; i += 500) {
      const page = deletedProductIds.slice(i, i + 500);
      await prisma.product.deleteMany({
        where: {
          shop: history.shop,
          mirrorBatchId: batchId,
          id: { in: page },
        },
      }).catch(() => {});
    }
  }
}

async function verifyBulkEditOutcome(history, session) {
  const rules = asArray(history.rules);
  const fields = rules.map((rule) => String(rule?.field || "")).filter(Boolean);
  const requiresVerification = fields.some((field) => isHighRiskVerificationRule(field));
  if (!requiresVerification) {
    return {
      verificationStatus: "NOT_REQUIRED",
      verificationSampleSize: 0,
      verificationFailures: [],
    };
  }

  const snapshots = await prisma.targetSnapshot.findMany({
    where: {
      shop: history.shop,
      ownerType: "EDIT_HISTORY",
      ownerId: history.id,
      mirrorBatchId: history.targetMirrorBatchId || undefined,
    },
    orderBy: [{ ordinal: "asc" }, { id: "asc" }],
    select: {
      targetType: true,
      productId: true,
      variantId: true,
      targetIdentity: true,
    },
  });

  const highRisk = fields.some((field) => isHighRiskVerificationRule(field));
  const destructiveVerification = isDestructiveVerificationRequired(history, fields);
  const sampledSnapshots = destructiveVerification || highRisk
    ? snapshots
    : pickVerificationSample(snapshots, 100);

  const productIds = [...new Set(sampledSnapshots.map((row) => row.productId).filter(Boolean))];
  const variantIds = [...new Set(sampledSnapshots.map((row) => row.variantId).filter(Boolean))];
  const nodes = await fetchShopifyNodesByIds(session, [...productIds, ...variantIds]);
  const nodeMap = new Map(nodes.filter(Boolean).map((node) => [String(node.id), node]));

  const failures = [];
  for (const rule of rules) {
    const field = String(rule?.field || "");
    const expectedValue = rule?.value;

    if (field === "deleteProducts") {
      for (const row of sampledSnapshots.filter((item) => item.targetType === "PRODUCT")) {
        if (nodeMap.has(String(row.productId))) {
          failures.push({
            targetIdentity: row.targetIdentity,
            field,
            expected: "deleted",
            actual: "exists",
          });
        }
      }
      continue;
    }

    if (["status", "title", "vendor", "productType", "handle"].includes(field)) {
      for (const row of sampledSnapshots.filter((item) => item.targetType === "PRODUCT")) {
        const node = nodeMap.get(String(row.productId));
        if (!node || node.__typename !== "Product") continue;
        const actual = node[field] ?? null;
        if (expectedValue !== undefined && expectedValue !== null && String(actual) !== String(expectedValue)) {
          failures.push({
            targetIdentity: row.targetIdentity,
            field,
            expected: expectedValue,
            actual,
          });
        }
      }
      continue;
    }

    if (["price", "compareAtPrice", "sku", "barcode", "inventory"].includes(field)) {
      for (const row of sampledSnapshots.filter((item) => item.targetType === "VARIANT")) {
        const node = nodeMap.get(String(row.variantId));
        if (!node || node.__typename !== "ProductVariant") continue;
        const mappedField = field === "inventory" ? "inventoryQuantity" : field;
        const actual = node[mappedField] ?? null;
        if (expectedValue !== undefined && expectedValue !== null && String(actual) !== String(expectedValue)) {
          failures.push({
            targetIdentity: row.targetIdentity,
            field,
            expected: expectedValue,
            actual,
          });
        }
      }
    }
  }

  const verificationStatus =
    failures.length === 0
      ? "VERIFIED"
      : failures.length < Math.max(1, Math.floor(sampledSnapshots.length * 0.2))
        ? "PARTIAL"
        : "FAILED";

  if (destructiveVerification) {
    const failureSet = new Set(failures.map((item) => String(item.targetIdentity || "")));
    const verifiedSet = new Set(
      sampledSnapshots
        .map((row) => String(row.targetIdentity || ""))
        .filter((identity) => identity && !failureSet.has(identity)),
    );
    if (verifiedSet.size > 0) {
      const verifiedList = [...verifiedSet];
      for (let i = 0; i < verifiedList.length; i += 500) {
        const page = verifiedList.slice(i, i + 500);
        await prisma.changeRecord.updateMany({
          where: {
            editHistoryId: history.id,
            shop: history.shop,
            targetIdentity: { in: page },
          },
          data: {
            status: "VERIFIED",
          },
        }).catch(() => {});
      }
    }
    if (failureSet.size > 0) {
      const failedList = [...failureSet];
      for (let i = 0; i < failedList.length; i += 500) {
        const page = failedList.slice(i, i + 500);
        await prisma.changeRecord.updateMany({
          where: {
            editHistoryId: history.id,
            shop: history.shop,
            targetIdentity: { in: page },
          },
          data: {
            status: "FAILED",
            failureCode: "VERIFICATION_MISMATCH",
            failureMessage: "Post-execution verification mismatch against Shopify state.",
          },
        }).catch(() => {});
      }
    }
    await patchMirrorFromVerifiedNodes(history, nodes).catch(() => {});
  }

  return {
    verificationStatus,
    verificationSampleSize: sampledSnapshots.length,
    verificationFailures: failures.slice(0, 200),
    verificationMode: destructiveVerification ? "FULL_DESTRUCTIVE" : "SAMPLE_PLUS_FAILURES",
  };
}

function mergeProductForBulkMirror(existing, incoming) {
  const rawStatus = preferIncomingOrExisting(
    incoming.status,
    existing?.status ?? "ACTIVE",
  );
  return {
    shop: existing?.shop ?? incoming.shop,
    id: existing?.id ?? incoming.id,
    title: preferNonEmptyStringOrExisting(incoming.title, existing?.title ?? ""),
    handle: preferIncomingOrExisting(incoming.handle, existing?.handle ?? null),
    status: rawStatus,
    statusNormalized: normalizeProductStatus(
      preferIncomingOrExisting(
        incoming.statusNormalized,
        existing?.statusNormalized ?? rawStatus,
      ),
    ),
    productType: preferIncomingOrExisting(incoming.productType, existing?.productType ?? null),
    vendor: preferIncomingOrExisting(incoming.vendor, existing?.vendor ?? null),
    tags: Array.isArray(incoming.tags)
      ? incoming.tags
      : Array.isArray(existing?.tags)
        ? existing.tags
        : [],
    templateSuffix: preferIncomingOrExisting(incoming.templateSuffix, existing?.templateSuffix ?? null),
    descriptionHtml: preferIncomingOrExisting(incoming.descriptionHtml, existing?.descriptionHtml ?? null),
    descriptionText: preferIncomingOrExisting(incoming.descriptionText, existing?.descriptionText ?? null),

    createdAt: preferIncomingOrExisting(incoming.createdAt, existing?.createdAt ?? null),
    updatedAt: preferIncomingOrExisting(incoming.updatedAt, existing?.updatedAt ?? null),
    publishedAt: preferIncomingOrExisting(incoming.publishedAt, existing?.publishedAt ?? null),
    seoTitle: preferIncomingOrExisting(incoming.seoTitle, existing?.seoTitle ?? null),
    seoDescription: preferIncomingOrExisting(incoming.seoDescription, existing?.seoDescription ?? null),
    totalInventory: preferIncomingOrExisting(incoming.totalInventory, existing?.totalInventory ?? null),
    categoryId: preferIncomingOrExisting(incoming.categoryId, existing?.categoryId ?? null),
    categoryName: preferIncomingOrExisting(incoming.categoryName, existing?.categoryName ?? null),
    featuredImageUrl: preferIncomingOrExisting(incoming.featuredImageUrl, existing?.featuredImageUrl ?? null),
    featuredImageAltText: preferIncomingOrExisting(incoming.featuredImageAltText, existing?.featuredImageAltText ?? null),
    optionsJson: preferIncomingOrExisting(incoming.optionsJson, existing?.optionsJson ?? null),
    collectionsJson: preferIncomingOrExisting(incoming.collectionsJson, existing?.collectionsJson ?? null),
    option1Name: preferIncomingOrExisting(incoming.option1Name, existing?.option1Name ?? null),
    option2Name: preferIncomingOrExisting(incoming.option2Name, existing?.option2Name ?? null),
    option3Name: preferIncomingOrExisting(incoming.option3Name, existing?.option3Name ?? null),
    variantCount: preferIncomingOrExisting(incoming.variantCount, existing?.variantCount ?? null),
    visibleOnlineStore: preferIncomingOrExisting(incoming.visibleOnlineStore, existing?.visibleOnlineStore ?? null),
  };
}

function toVariantNestedCreateInput(variant) {
  return {
    id: String(variant.id),
    title: variant.title ?? null,
    sku: variant.sku ?? null,
    barcode: variant.barcode ?? null,
    price: toNullableFloat(variant.price),
    compareAtPrice: toNullableFloat(variant.compareAtPrice),
    inventoryQuantity: toNullableInt(variant.inventoryQuantity),
    inventoryPolicy: variant.inventoryPolicy ?? null,
    taxable: toNullableBoolean(variant.taxable),
    taxCode: variant.taxCode ?? null,
    position: toNullableInt(variant.position),
    selectedOptionsJson: variant.selectedOptionsJson ?? null,
    cost: toNullableFloat(variant.cost),
    countryOfOrigin: variant.countryOfOrigin ?? null,
    hsTariffCode: variant.hsTariffCode ?? null,
    weight: toNullableFloat(variant.weight),
    weightUnit: variant.weightUnit ?? null,
    option1Value: variant.option1Value ?? null,
    option2Value: variant.option2Value ?? null,
    option3Value: variant.option3Value ?? null,
    physicalProduct: toNullableBoolean(variant.physicalProduct),
    profitMargin: toNullableFloat(variant.profitMargin),
    tracked: toNullableBoolean(variant.tracked),
  };
}

function toProductCreateInput(product, variants, mirrorBatchId = null) {
  if (!mirrorBatchId) {
    throw new Error("mirrorBatchId is required to create mirrored product input");
  }
  const rawStatus = product.status ?? "ACTIVE";
  return {
    shop: String(product.shop),
    id: String(product.id),
    mirrorBatchId,
    title: product.title ?? "",
    handle: product.handle ?? null,
    status: rawStatus,
    statusNormalized: normalizeProductStatus(
      product.statusNormalized ?? rawStatus,
    ),
    productType: product.productType ?? null,
    vendor: product.vendor ?? null,
    tags: asArray(product.tags),
    templateSuffix: product.templateSuffix ?? null,
     descriptionHtml: product.descriptionHtml ?? null,
    descriptionText: product.descriptionText ?? null,
    createdAt: product.createdAt ?? null,
    updatedAt: product.updatedAt ?? null,
    publishedAt: product.publishedAt ?? null,
    seoTitle: product.seoTitle ?? null,
    seoDescription: product.seoDescription ?? null,
    totalInventory: toNullableInt(product.totalInventory),
    categoryId: product.categoryId ?? null,
    categoryName: product.categoryName ?? null,
    featuredImageUrl: product.featuredImageUrl ?? null,
    featuredImageAltText: product.featuredImageAltText ?? null,
    optionsJson: product.optionsJson ?? null,
    collectionsJson: product.collectionsJson ?? null,
    option1Name: product.option1Name ?? null,
    option2Name: product.option2Name ?? null,
    option3Name: product.option3Name ?? null,
    variantCount: toNullableInt(product.variantCount),
    visibleOnlineStore: toNullableBoolean(product.visibleOnlineStore),
    variants: {
      create: asArray(variants).map((variant) => toVariantNestedCreateInput(variant)),
    },
  };
}

function buildBulkFailureError(history, bulkOperation, stage, message, retryable = false) {
  return appendExecutionError(
    history.error,
    buildExecutionError({
      code: bulkOperation?.errorCode || "shopify_bulk_failure",
      stage,
      message,
      retryable,
      details: {
        bulkOperationId: bulkOperation?.id || history.bulkOperationId || null,
        bulkStatus: bulkOperation?.status || null,
        partialDataUrl: bulkOperation?.partialDataUrl || null,
        objectCount: bulkOperation?.objectCount || bulkOperation?.rootObjectCount || null,
      },
    }),
  );
}

async function streamBulkOperationJsonl(url, onRow) {
  const response = await axios.get(url, {
    responseType: "stream",
    timeout: 120000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  const rl = readline.createInterface({
    input: response.data,
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      await onRow(parsed);
    } catch (_error) {
      // Ignore malformed JSONL lines for robustness; ingestion counts will reflect only parsed rows.
    }
  }
}

function classifyFailureType(errors = []) {
  const messages = (Array.isArray(errors) ? errors : [])
    .map((item) => String(item?.message || ""))
    .join(" ")
    .toLowerCase();
  if (
    messages.includes("throttl")
    || messages.includes("timeout")
    || messages.includes("temporar")
    || messages.includes("try again")
  ) {
    return "retryable";
  }
  return "permanent";
}

function collectBulkResultNodeIds(row) {
  const ids = new Set();
  const pushId = (value) => {
    const id = String(value || "").trim();
    if (id) ids.add(id);
  };
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node.id) pushId(node.id);
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") walk(value);
    }
  };
  walk(row);
  return ids;
}

function extractBulkRowErrors(row) {
  const errors = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const userErrors = Array.isArray(node.userErrors) ? node.userErrors : [];
    if (userErrors.length > 0) {
      errors.push(...userErrors);
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") walk(value);
    }
  };
  walk(row);
  return errors;
}

async function ingestBulkOperationResultRows(history, bulkOperation) {
  if (!bulkOperation?.url) {
    return {
      totalTargets: Number(history.targetSnapshotCount || 0),
      submittedCount: 0,
      successCount: 0,
      failedCount: 0,
      skippedCount: Number(history.targetSnapshotCount || 0),
      retryableFailureCount: 0,
      permanentFailureCount: 0,
    };
  }

  const snapshots = await prisma.targetSnapshot.findMany({
    where: {
      shop: history.shop,
      ownerType: "EDIT_HISTORY",
      ownerId: history.id,
      ...(history.targetMirrorBatchId ? { mirrorBatchId: history.targetMirrorBatchId } : {}),
    },
    select: {
      targetIdentity: true,
      productId: true,
      variantId: true,
      targetType: true,
    },
  });

  const snapshotByProductId = new Map();
  const snapshotByVariantId = new Map();
  for (const row of snapshots) {
    if (row.productId) {
      const key = String(row.productId);
      const list = snapshotByProductId.get(key) || [];
      list.push(row);
      snapshotByProductId.set(key, list);
    }
    if (row.variantId) {
      const key = String(row.variantId);
      const list = snapshotByVariantId.get(key) || [];
      list.push(row);
      snapshotByVariantId.set(key, list);
    }
  }

  const counters = {
    totalTargets: snapshots.length,
    submittedCount: 0,
    successCount: 0,
    failedCount: 0,
    skippedCount: 0,
    retryableFailureCount: 0,
    permanentFailureCount: 0,
  };
  const submittedTargets = new Set();
  const successTargets = new Set();
  const failedTargets = new Set();
  const retryableFailureTargets = new Set();
  const permanentFailureTargets = new Set();
  const matchedTargetIdentitySet = new Set();

  await streamBulkOperationJsonl(bulkOperation.url, async (row) => {
    const referencedIds = collectBulkResultNodeIds(row);
    const targetsByIdentity = new Map();
    for (const id of referencedIds) {
      const productTargets = snapshotByProductId.get(id) || [];
      for (const target of productTargets) {
        targetsByIdentity.set(target.targetIdentity, target);
      }
      const variantTargets = snapshotByVariantId.get(id) || [];
      for (const target of variantTargets) {
        targetsByIdentity.set(target.targetIdentity, target);
      }
    }
    const targets = [...targetsByIdentity.values()];
    if (!targets.length) return;
    const userErrors = extractBulkRowErrors(row);
    const isFailure = userErrors.length > 0;
    const failureType = isFailure ? classifyFailureType(userErrors) : null;

    for (const target of targets) {
      const targetIdentity = String(target.targetIdentity || "").trim();
      if (!targetIdentity) continue;
      submittedTargets.add(targetIdentity);
      matchedTargetIdentitySet.add(targetIdentity);
      if (isFailure) {
        failedTargets.add(target.targetIdentity);
        successTargets.delete(targetIdentity);
        if (failureType === "retryable") {
          retryableFailureTargets.add(targetIdentity);
          permanentFailureTargets.delete(targetIdentity);
        } else {
          permanentFailureTargets.add(targetIdentity);
          retryableFailureTargets.delete(targetIdentity);
        }
      } else if (!failedTargets.has(targetIdentity)) {
        successTargets.add(targetIdentity);
      }
    }
  });

  counters.submittedCount = submittedTargets.size;
  counters.successCount = successTargets.size;
  counters.failedCount = failedTargets.size;
  counters.retryableFailureCount = retryableFailureTargets.size;
  counters.permanentFailureCount = permanentFailureTargets.size;
  counters.skippedCount = Math.max(counters.totalTargets - counters.submittedCount, 0);

  if (matchedTargetIdentitySet.size > 0) {
    const successList = [...successTargets];
    for (let i = 0; i < successList.length; i += 500) {
      const page = successList.slice(i, i + 500);
      await prisma.changeRecord.updateMany({
        where: {
          editHistoryId: history.id,
          shop: history.shop,
          targetIdentity: { in: page },
        },
        data: {
          status: "SUCCESS",
          failureCode: null,
          failureMessage: null,
        },
      });
    }
    const failedList = [...failedTargets];
    for (let i = 0; i < failedList.length; i += 500) {
      const page = failedList.slice(i, i + 500);
      await prisma.changeRecord.updateMany({
        where: {
          editHistoryId: history.id,
          shop: history.shop,
          targetIdentity: { in: page },
        },
        data: {
          status: "FAILED",
          failureCode: "SHOPIFY_ROW_MUTATION_ERROR",
          failureMessage: "One or more row-level Shopify mutation errors were reported in bulk operation results.",
        },
      });
    }
  }

  return counters;
}

async function claimBulkEditFinalization(history) {
  const undo = normalizeUndoState(history.undo);

  const rawState = String(history.executionState || "").toUpperCase();
  if (
    (history.executionState === BULK_EDIT_EXECUTION_STATES.AWAITING_SHOPIFY
      || rawState === OPERATION_LIFECYCLE_STATES.SHOPIFY_BULK_SUBMITTED
      || rawState === OPERATION_LIFECYCLE_STATES.SHOPIFY_RUNNING) &&
    history.status === "processing"
  ) {
    const updated = await prisma.editHistory.updateMany({
      where: {
        id: history.id,
        shop: history.shop,
        bulkOperationId: history.bulkOperationId,
        executionStateNormalized: normalizeEditHistoryExecutionState(
          BULK_EDIT_EXECUTION_STATES.AWAITING_SHOPIFY,
        ),
        statusNormalized: normalizeEditHistoryStatus("processing"),
      },
      data: {
        executionState: BULK_EDIT_EXECUTION_STATES.FINALIZING,
        executionStateNormalized: normalizeEditHistoryExecutionState(
          BULK_EDIT_EXECUTION_STATES.FINALIZING,
        ),
      },
    });

    return updated.count === 1 ? "edit" : null;
  }

  if (
    undo.status === "processing" &&
    undo.state === BULK_UNDO_STATES.AWAITING_SHOPIFY &&
    undo.bulkOperationId === history.bulkOperationId
  ) {
    const updated = await prisma.editHistory.updateMany({
      where: {
        id: history.id,
        shop: history.shop,
        bulkOperationId: history.bulkOperationId,
      },
      data: {
        undo: {
          ...undo,
          state: BULK_UNDO_STATES.FINALIZING,
        },
      },
    });

    return updated.count === 1 ? "undo" : null;
  }

  return null;
}

async function setLifecycleExecutionState(history, state) {
  await prisma.editHistory.updateMany({
    where: { id: history.id, shop: history.shop },
    data: {
      executionState: state,
      executionStateNormalized: normalizeEditHistoryExecutionState(state),
    },
  });
}

async function markHistoryFailure(history, bulkOperation, reason, stage, kind = "edit") {
  const undo = normalizeUndoState(history.undo);
  const completedAt = new Date();

  if (kind === "undo") {
    await prisma.editHistory.update({
      where: { id: history.id },
      data: {
        bulkOperationId: null,
        processingBatchId: null,
        undo: {
          ...undo,
          status: "failed",
          state:
            bulkOperation?.partialDataUrl ? BULK_UNDO_STATES.PARTIAL : BULK_UNDO_STATES.FAILED,
          completedAt,
          durationMs: calculateDurationMs(undo.startedAt || history.startedAt, completedAt),
          error: buildExecutionError({
            code: bulkOperation?.errorCode || "undo_bulk_failure",
            stage,
            message: reason,
            retryable: false,
            details: {
              bulkOperationId: bulkOperation?.id || history.bulkOperationId || null,
              bulkStatus: bulkOperation?.status || null,
              partialDataUrl: bulkOperation?.partialDataUrl || null,
            },
          }),
          bulkOperationId: null,
        },
      },
    });
    return;
  }

  await prisma.editHistory.update({
    where: { id: history.id },
    data: {
      status: bulkOperation?.partialDataUrl ? "partial" : "failed",
      statusNormalized: normalizeEditHistoryStatus(
        bulkOperation?.partialDataUrl ? "partial" : "failed",
      ),
      executionState: bulkOperation?.partialDataUrl
        ? OPERATION_LIFECYCLE_STATES.PARTIAL_FAILED
        : OPERATION_LIFECYCLE_STATES.FAILED,
      executionStateNormalized: normalizeEditHistoryExecutionState(
        bulkOperation?.partialDataUrl
          ? OPERATION_LIFECYCLE_STATES.PARTIAL_FAILED
          : OPERATION_LIFECYCLE_STATES.FAILED,
      ),
      failureStage: stage,
      completedAt,
      durationMs: calculateDurationMs(history.startedAt, completedAt),
      processingBatchId: null,
      error: buildBulkFailureError(history, bulkOperation, stage, reason, false),
    },
  });

}

async function markProcessingBatchStatus(batchId, status) {
  if (!batchId) return;
  await prisma.changeRecord.updateMany({
    where: { batchId },
    data: { status },
  });
}

async function applyBulkMirrorUpdates(history, bulkOperation) {
  if (!bulkOperation?.url) {
    return;
  }

  const batchId = await getActiveMirrorBatchId(history.shop, {
    purpose: "WEBHOOK_INCREMENTAL",
  }).catch(async () => {
    await markRepairRequired({
      shop: history.shop,
      reason: MIRROR_STALE_REASONS.PARTIAL_MIRROR_DETECTED,
      summary: "Missing active mirror batch during bulk webhook apply; full repair sync required",
      details: {
        historyId: history.id,
        bulkOperationId: bulkOperation?.id || history.bulkOperationId || null,
      },
    }).catch(() => {});
    await addShopSyncJob({
      shop: history.shop,
      syncType: "product",
      reason: "bulk_webhook_missing_active_batch",
    }).catch(() => {});
    return null;
  });
  if (!batchId) {
    throw new Error("Cannot apply bulk mirror updates without active mirror batch");
  }

  const records = await fetchBulkOperationData(bulkOperation.url, history.shop);
  if (!records.length) {
    return;
  }

  await prisma.$transaction(
    async (tx) => {
      for (const { product, variants = [] } of records) {
        const existing = await tx.product.findFirst({
          where: {
            shop: product.shop,
            id: product.id,
            mirrorBatchId: batchId,
          },
          select: {
            shop: true,
            id: true,
            title: true,
            handle: true,
            status: true,
            statusNormalized: true,
            productType: true,
            vendor: true,
            tags: true,
            templateSuffix: true,
            descriptionHtml: true,
            descriptionText: true,
            createdAt: true,
            updatedAt: true,
            publishedAt: true,
            seoTitle: true,
            seoDescription: true,
            totalInventory: true,
            categoryId: true,
            categoryName: true,
            featuredImageUrl: true,
            featuredImageAltText: true,
            optionsJson: true,
            collectionsJson: true,
            option1Name: true,
            option2Name: true,
            option3Name: true,
            variantCount: true,
            visibleOnlineStore: true,
          },
        });

        const mergedProduct = mergeProductForBulkMirror(existing, product);

        await tx.product.upsert({
          where: {
            shop_id_mirrorBatchId: {
              shop: product.shop,
              id: product.id,
              mirrorBatchId: batchId,
            },
          },
          create: {
            shop: String(mergedProduct.shop),
            id: String(mergedProduct.id),
            mirrorBatchId: batchId,
            title: mergedProduct.title ?? "",
            handle: mergedProduct.handle ?? null,
            status: mergedProduct.status ?? "ACTIVE",
            statusNormalized: normalizeProductStatus(
              mergedProduct.statusNormalized ?? mergedProduct.status ?? "ACTIVE",
            ),
            productType: mergedProduct.productType ?? null,
            vendor: mergedProduct.vendor ?? null,
            tags: asArray(mergedProduct.tags),
            templateSuffix: mergedProduct.templateSuffix ?? null,
            descriptionHtml: mergedProduct.descriptionHtml ?? null,
            descriptionText: mergedProduct.descriptionText ?? null,
            createdAt: mergedProduct.createdAt ?? null,
            updatedAt: mergedProduct.updatedAt ?? null,
            publishedAt: mergedProduct.publishedAt ?? null,
            seoTitle: mergedProduct.seoTitle ?? null,
            seoDescription: mergedProduct.seoDescription ?? null,
            totalInventory: toNullableInt(mergedProduct.totalInventory),
            categoryId: mergedProduct.categoryId ?? null,
            categoryName: mergedProduct.categoryName ?? null,
            featuredImageUrl: mergedProduct.featuredImageUrl ?? null,
            featuredImageAltText: mergedProduct.featuredImageAltText ?? null,
            optionsJson: mergedProduct.optionsJson ?? null,
            collectionsJson: mergedProduct.collectionsJson ?? null,
            option1Name: mergedProduct.option1Name ?? null,
            option2Name: mergedProduct.option2Name ?? null,
            option3Name: mergedProduct.option3Name ?? null,
            variantCount: toNullableInt(mergedProduct.variantCount),
            visibleOnlineStore: toNullableBoolean(
              mergedProduct.visibleOnlineStore,
            ),
          },
          update: {
            title: mergedProduct.title ?? undefined,
            handle: mergedProduct.handle ?? undefined,
            status: mergedProduct.status ?? undefined,
            statusNormalized: mergedProduct.statusNormalized
              ? normalizeProductStatus(mergedProduct.statusNormalized)
              : undefined,
            productType: mergedProduct.productType ?? undefined,
            vendor: mergedProduct.vendor ?? undefined,
            tags: asArray(mergedProduct.tags),
            templateSuffix: mergedProduct.templateSuffix ?? undefined,
            descriptionHtml: mergedProduct.descriptionHtml ?? undefined,
            descriptionText: mergedProduct.descriptionText ?? undefined,
            updatedAt: mergedProduct.updatedAt ?? undefined,
            publishedAt: mergedProduct.publishedAt ?? undefined,
            seoTitle: mergedProduct.seoTitle ?? undefined,
            seoDescription: mergedProduct.seoDescription ?? undefined,
            totalInventory: toNullableInt(mergedProduct.totalInventory),
            categoryId: mergedProduct.categoryId ?? undefined,
            categoryName: mergedProduct.categoryName ?? undefined,
            featuredImageUrl: mergedProduct.featuredImageUrl ?? undefined,
            featuredImageAltText:
              mergedProduct.featuredImageAltText ?? undefined,
            optionsJson: mergedProduct.optionsJson ?? undefined,
            collectionsJson: mergedProduct.collectionsJson ?? undefined,
            option1Name: mergedProduct.option1Name ?? undefined,
            option2Name: mergedProduct.option2Name ?? undefined,
            option3Name: mergedProduct.option3Name ?? undefined,
            variantCount: toNullableInt(mergedProduct.variantCount),
            visibleOnlineStore:
              mergedProduct.visibleOnlineStore === undefined
                ? undefined
                : toNullableBoolean(mergedProduct.visibleOnlineStore),
          },
        });

        if (variants.length > 0) {
          for (const variant of variants) {
            const variantData = toVariantNestedCreateInput(variant);

            await tx.variant.upsert({
              where: {
                shop_id_mirrorBatchId: {
                  shop: product.shop,
                  id: variantData.id,
                  mirrorBatchId: batchId,
                },
              },
              create: {
                ...variantData,
                shop: product.shop,
                productId: product.id,
                mirrorBatchId: batchId,
              },
              update: {
                title: variantData.title ?? undefined,
                sku: variantData.sku ?? undefined,
                barcode: variantData.barcode ?? undefined,
                price: variantData.price ?? undefined,
                compareAtPrice: variantData.compareAtPrice ?? undefined,
                inventoryQuantity: variantData.inventoryQuantity ?? undefined,
                inventoryPolicy: variantData.inventoryPolicy ?? undefined,
                taxable: variantData.taxable ?? undefined,
                taxCode: variantData.taxCode ?? undefined,
                position: variantData.position ?? undefined,
                selectedOptionsJson: variantData.selectedOptionsJson ?? undefined,
                cost: variantData.cost ?? undefined,
                countryOfOrigin: variantData.countryOfOrigin ?? undefined,
                hsTariffCode: variantData.hsTariffCode ?? undefined,
                weight: variantData.weight ?? undefined,
                weightUnit: variantData.weightUnit ?? undefined,
                option1Value: variantData.option1Value ?? undefined,
                option2Value: variantData.option2Value ?? undefined,
                option3Value: variantData.option3Value ?? undefined,
                physicalProduct: variantData.physicalProduct ?? undefined,
                profitMargin: variantData.profitMargin ?? undefined,
                tracked: variantData.tracked ?? undefined,
              },
            });
          }
        }
      }
    },
    { maxWait: 10_000, timeout: 60_000 },
  );

  await clearKeyCaches(`${history.shop}:ProductFetch:`);
  await clearKeyCaches(`${history.shop}:ProductFilterValues:`);
  await clearKeyCaches(`${history.shop}:productTypes:`);
}

async function finalizeEditSuccess(history) {
  const session = await getSession(history.shop);
  await setLifecycleExecutionState(history, OPERATION_LIFECYCLE_STATES.VERIFYING);
  const batch = asObject(history.batch);
  const batchTargetCount = Number(batch.currentBatchTargetCount || 0);
  const nextProcessedCount = Math.min(
    Number(history.processedCount || 0) + batchTargetCount,
    Number(history.targetSnapshotCount || Number(history.totalItems || 0)),
  );
  const hasMore = Boolean(batch.hasMore);
  if (history.processingBatchId) {
    await prisma.changeRecord.updateMany({
      where: {
        editHistoryId: history.id,
        shop: history.shop,
        batchId: history.processingBatchId,
        status: "PENDING",
      },
      data: {
        status: "SUCCESS",
      },
    }).catch(() => {});
  }

  await markProcessingBatchStatus(history.processingBatchId, "completed");

  
  if (hasMore) {
    const latest = await prisma.editHistory.findUnique({
      where: { id: history.id },
      select: { cancelRequestedAt: true, pauseRequestedAt: true },
    });
    if (latest?.cancelRequestedAt) {
      const cancelledAt = new Date();
      await prisma.editHistory.update({
        where: { id: history.id },
        data: {
          status: "cancelled",
          statusNormalized: normalizeEditHistoryStatus("cancelled"),
          executionState: OPERATION_LIFECYCLE_STATES.CANCELLED,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            OPERATION_LIFECYCLE_STATES.CANCELLED,
          ),
          cancelledAt,
          completedAt: cancelledAt,
          processedCount: nextProcessedCount,
          processingBatchId: null,
          bulkOperationId: null,
          batch: {
            ...batch,
            hasMore: false,
            currentBatchId: null,
            currentBatchCount: 0,
            currentBatchTargetCount: 0,
            lastFinalizedAt: cancelledAt.toISOString(),
          },
        },
      });
      return { continued: false, cancelled: true };
    }
    if (latest?.pauseRequestedAt) {
      const pausedAt = new Date();
      await prisma.editHistory.update({
        where: { id: history.id },
        data: {
          executionState: OPERATION_LIFECYCLE_STATES.PAUSED,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            OPERATION_LIFECYCLE_STATES.PAUSED,
          ),
          status: "pending",
          statusNormalized: normalizeEditHistoryStatus("pending"),
          pausedAt,
          processedCount: nextProcessedCount,
          processingBatchId: null,
          bulkOperationId: null,
          batch: {
            ...batch,
            currentBatchId: null,
            currentBatchCount: 0,
            currentBatchTargetCount: 0,
            hasMore: true,
            lastFinalizedAt: pausedAt.toISOString(),
          },
        },
      });
      return { continued: false, paused: true };
    }

    const updatedBatch = {
      ...batch,
      currentBatchId: null,
      currentBatchCount: 0,
      currentBatchTargetCount: 0,
      lastFinalizedAt: new Date().toISOString(),
    };

    await prisma.editHistory.update({
      where: { id: history.id },
      data: {
        processedCount: nextProcessedCount,
        durationMs: calculateDurationMs(history.startedAt),
        executionState: OPERATION_LIFECYCLE_STATES.QUEUED,
        executionStateNormalized: normalizeEditHistoryExecutionState(
          OPERATION_LIFECYCLE_STATES.QUEUED,
        ),
        bulkOperationId: null,
        processingBatchId: null,
        batch: updatedBatch,
      },
    });

    await addBulkEditExecuteJob({
      historyId: history.id,
      shop: history.shop,
      source: "bulk_edit_continuation",
      executionId: history.executionIdentity || history.id,
    });

    return { continued: true };
  }

  const completedAt = new Date();
  const latestForVerification = await prisma.editHistory.findUnique({
    where: { id: history.id },
    select: { cancelRequestedAt: true },
  });
  const verification = latestForVerification?.cancelRequestedAt
    ? {
      verificationStatus: "CANCELLED",
      verificationSampleSize: 0,
      verificationFailures: [],
    }
    : await verifyBulkEditOutcome(history, session);
  if (verification.verificationStatus === "FAILED") {
    await markRepairRequired({
      shop: history.shop,
      reason: MIRROR_STALE_REASONS.FULL_SYNC_FAILED,
      details: {
        historyId: history.id,
        verificationStatus: verification.verificationStatus,
      },
    }).catch(() => {});
    await addShopSyncJob({
      shop: history.shop,
      syncType: "manual",
      source: "bulk_edit_verification_failed",
    }).catch(() => {});
  }
  const { email, shopOwner } = await getShopOwnerEmailAddress(session);

  await sendEmail(
    email,
    "Your product edits are complete",
    productEditConfirmationEmailHTML(shopOwner, history.shop, history),
    true,
  );

  await prisma.editHistory.update({
    where: { id: history.id },
    data: {
      status: "completed",
      statusNormalized: normalizeEditHistoryStatus("completed"),
      executionState: OPERATION_LIFECYCLE_STATES.COMPLETED,
      executionStateNormalized: normalizeEditHistoryExecutionState(
        OPERATION_LIFECYCLE_STATES.COMPLETED,
      ),
      completedAt,
      editTime: completedAt,
      processedCount: nextProcessedCount,
      durationMs: calculateDurationMs(history.startedAt, completedAt),
      processingBatchId: null,
      bulkOperationId: null,
      batch: {
        ...batch,
        ingestionSummary: batch.ingestionSummary || null,
        verificationStatus: verification.verificationStatus,
        verificationMode: verification.verificationMode || null,
        verificationSampleSize: verification.verificationSampleSize,
        verificationFailures: verification.verificationFailures,
        retryFailedOnly: false,
        retryTargetIdentities: [],
        retryCursorIndex: 0,
        lastProductId: null,
        hasMore: false,
        currentBatchId: null,
        currentBatchCount: 0,
        currentBatchTargetCount: 0,
        lastFinalizedAt: completedAt.toISOString(),
      },
    },
  });

  const triggerSource = String(history.triggerType || "MANUAL").toUpperCase();
  const reconciliationSource =
    triggerSource === "RECURRING"
      ? "RECURRING_RUN"
      : triggerSource === "SCHEDULED_ONCE"
        ? "SCHEDULED_EXECUTE"
        : triggerSource === "AUTOMATIC_RULE"
          ? "AUTOMATIC_RULE_RUN"
          : "MANUAL_EXECUTE";
  await schedulePostMutationMirrorReconciliation({
    shop: history.shop,
    ownerType: "EDIT_HISTORY",
    ownerId: history.id,
    mirrorBatchId: history.targetMirrorBatchId || null,
    source: reconciliationSource,
    verificationStatus: verification.verificationStatus,
  }).catch(() => {});

  await finalizeRecurringRunFromHistory({
    historyId: history.id,
    status: "SUCCESS",
  });

  await finalizeAutomaticProductRuleRunFromHistory({
    historyId: history.id,
    status: "SUCCESS",
    processingToken: await findAutomaticRuleProcessingToken(history.id),
  });

  return { continued: false };
}

async function finalizeUndoSuccess(history) {
  const undo = normalizeUndoState(history.undo);
  const batch = asObject(history.batch);
  const batchTargetCount = Number(batch.currentBatchTargetCount || 0);
  const nextProcessedCount = Number(undo.processedCount || 0) + batchTargetCount;
  const hasMore = Boolean(batch.hasMore);

  await markProcessingBatchStatus(history.processingBatchId, "undo completed");

  if (hasMore) {
    await prisma.editHistory.update({
      where: { id: history.id },
      data: {
        bulkOperationId: null,
        processingBatchId: null,
        batch: {
          ...batch,
          currentBatchId: null,
          currentBatchCount: 0,
          currentBatchTargetCount: 0,
          lastUndoFinalizedAt: new Date().toISOString(),
        },
        undo: {
          ...undo,
          processedCount: nextProcessedCount,
          state: BULK_UNDO_STATES.QUEUED,
          bulkOperationId: null,
          durationMs: calculateDurationMs(undo.startedAt || history.startedAt),
        },
      },
    });

    await addbulkUndoJob({
      historyId: history.id,
      shop: history.shop,
      source: "bulk_undo_continuation",
      executionId: undo.executionIdentity || history.executionIdentity || history.id,
    });

    return { continued: true };
  }

  const completedAt = new Date();
  await prisma.editHistory.update({
    where: { id: history.id },
    data: {
      bulkOperationId: null,
      processingBatchId: null,
      batch: {
        ...batch,
        lastProductId: null,
        hasMore: false,
        currentBatchId: null,
        currentBatchCount: 0,
        currentBatchTargetCount: 0,
        lastUndoFinalizedAt: completedAt.toISOString(),
      },
      undo: {
        ...undo,
        status: "completed",
        state: BULK_UNDO_STATES.COMPLETED,
        allowed: false,
        completedAt,
        processedCount: nextProcessedCount,
        durationMs: calculateDurationMs(undo.startedAt || history.startedAt, completedAt),
        bulkOperationId: null,
      },
    },
  });

  await clearKeyCaches(`${history.shop}:historyChanges:${history.id}`);
  return { continued: false };
}

export async function handleProductEditOperation({ bulkOperationId, shop = null }) {
  return {
    success: false,
    retired: true,
    reason: "LEGACY_BULK_FINALIZER_RETIRED",
    bulkOperationId: bulkOperationId || null,
    shop: shop || null,
  };
}

export async function fetchBulkOperationData(url, shop) {
  const response = await axios.get(url, {
    responseType: "text",
    timeout: 120000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  const operations = [];
  const lines = response.data.split("\n").filter(Boolean);

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const product = parsed?.data?.productSet?.product;
      if (!product?.id) continue;

      // Extract nested variants from edges
      const variants = asArray(product?.variants?.edges)
        .map((edge) => edge?.node)
        .filter((node) => node?.id)
        .map((node) => ({
          id: node.id,
          title: node.title ?? null,
          sku: node.sku ?? null,
          barcode: node.barcode ?? null,
          price: node.price != null ? Number(node.price) : null,
          compareAtPrice: node.compareAtPrice != null ? Number(node.compareAtPrice) : null,
          inventoryQuantity: node.inventoryQuantity != null ? Number(node.inventoryQuantity) : null,
          inventoryPolicy: node.inventoryPolicy ?? null,
          taxable: node.taxable ?? null,
          taxCode: node.taxCode ?? null,
          position: node.position != null ? Number(node.position) : null,
          selectedOptionsJson: node.selectedOptions ?? null,
          cost: node.inventoryItem?.unitCost?.amount != null
            ? Number(node.inventoryItem.unitCost.amount) : null,
          countryOfOrigin: node.inventoryItem?.countryCodeOfOrigin ?? null,
          hsTariffCode: node.inventoryItem?.harmonizedSystemCode ?? null,
          weight: node.inventoryItem?.measurement?.weight?.value != null
            ? Number(node.inventoryItem.measurement.weight.value) : null,
          weightUnit: node.inventoryItem?.measurement?.weight?.unit ?? null,
          option1Value: node.selectedOptions?.[0]?.value ?? null,
          option2Value: node.selectedOptions?.[1]?.value ?? null,
          option3Value: node.selectedOptions?.[2]?.value ?? null,
          physicalProduct: node.inventoryItem?.requiresShipping ?? null,
          tracked: node.inventoryItem?.tracked ?? null,
          profitMargin: null,
        }));

      const rawStatus = product.status ?? "ACTIVE";
      operations.push({
        product: {
          shop,
          id: product.id,
          title: product.title ?? null,
          handle: product.handle ?? null,
          status: rawStatus,
          statusNormalized: normalizeProductStatus(rawStatus),
          productType: product.productType ?? null,
          vendor: product.vendor ?? null,
          templateSuffix: product.templateSuffix ?? null,
          descriptionHtml: product.descriptionHtml ?? null,
          descriptionText: product.descriptionHtml
            ? product.descriptionHtml.replace(/<[^>]*>/g, " ").replace(/\s{2,}/g, " ").trim() || null
            : null,
          createdAt: product.createdAt ? new Date(product.createdAt) : null,
          updatedAt: product.updatedAt ? new Date(product.updatedAt) : null,
          publishedAt: product.publishedAt ? new Date(product.publishedAt) : null,
          tags: Array.isArray(product.tags) ? product.tags : [],
          categoryId: product.category?.id ?? null,
          categoryName: product.category?.name ?? null,
          seoTitle: product.seo?.title ?? null,
          seoDescription: product.seo?.description ?? null,
          totalInventory: product.totalInventory != null ? Number(product.totalInventory) : null,
          featuredImageUrl: product.featuredImage?.url ?? null,
          featuredImageAltText: product.featuredImage?.altText ?? null,
          optionsJson: product.options ?? null,
          collectionsJson: asArray(product?.collections?.edges).map(({ node }) => ({
            id: node?.id ?? null,
            title: node?.title ?? null,
          })),
          option1Name: product.options?.[0]?.name ?? null,
          option2Name: product.options?.[1]?.name ?? null,
          option3Name: product.options?.[2]?.name ?? null,
          variantCount: variants.length,
          visibleOnlineStore: null,
        },
        variants,
      });
    } catch (_error) {
      // skip malformed lines
    }
  }

  return operations;
}

async function processNextEdit(shop) {
  const nextEdit = await prisma.editHistory.findFirst({
    where: {
      shop,
      statusNormalized: {
        in: [
          normalizeEditHistoryStatus("pending"),
          normalizeEditHistoryStatus("undo_pending"),
        ],
      },
    },
    orderBy: { updatedAt: "asc" },
    select: {
      id: true,
      shop: true,
      status: true,
      executionIdentity: true,
      undo: true,
    },
  });

  if (!nextEdit) return;

  if (nextEdit.status === "Undo pending") {
    const undo = normalizeUndoState(nextEdit.undo);
    await addbulkUndoJob({
      historyId: nextEdit.id,
      shop: nextEdit.shop,
      source: "bulk_edit_followup_undo",
      executionId: undo.executionIdentity || nextEdit.executionIdentity || nextEdit.id,
    });
    return;
  }

  await addBulkEditExecuteJob({
    historyId: nextEdit.id,
    shop: nextEdit.shop,
    source: "bulk_edit_followup",
    executionId: nextEdit.executionIdentity || nextEdit.id,
  });
}

async function fetchBulkOperationDetails(session, bulkOperationId) {
  const query = `query GetBulkOperationResults($id: ID!) {
    node(id: $id) {
      ... on BulkOperation {
        id
        status
        errorCode
        url
        partialDataUrl
        objectCount
        rootObjectCount
        completedAt
        createdAt
        fileSize
        type
      }
    }
  }`;

  const response = await adminGraphqlWithRetry({
    session,
    shop: session?.shop,
    operationName: "bulkOperationMutationStatus",
    data: {
      query,
      variables: { id: bulkOperationId },
    },
  });

  return response.body?.data?.node ?? null;
}

export { processNextEdit };
