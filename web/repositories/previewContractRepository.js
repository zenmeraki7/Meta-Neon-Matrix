import crypto from "node:crypto";
import { db } from "./repositoryDb.js";
import { normalizeShopDomain } from "../utils/shopDomainUtils.js";

function requiredText(value, code) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

/**
 * Persists the server-built target set and its immutable preview authority in
 * one transaction. Callers must pass targets produced by the canonical field
 * registry; request/browser mutation values are not accepted by execution.
 */
export async function createTrustedPreviewContract({
  shop,
  operationId,
  mirrorBatchId,
  targetDefinitionHash,
  targetSetHash = null,
  compilerVersion,
  projectionVersion,
  plannerVersion = null,
  contractHash,
  payloadHash,
  expiresAt,
  snapshotItems,
  dbClient = db,
}) {
  const canonicalShop = normalizeShopDomain(shop);
  const normalizedItems = Array.isArray(snapshotItems) ? snapshotItems : [];
  const expiry = new Date(expiresAt);
  if (!canonicalShop || !Number.isFinite(expiry.getTime()) || expiry <= new Date()) {
    throw new Error("PREVIEW_CONTRACT_EXPIRY_INVALID");
  }

  return dbClient.$transaction(async (tx) => {
    const snapshotSetId = crypto.randomUUID();
    const previewContractId = crypto.randomUUID();
    const counts = normalizedItems.reduce((result, item) => {
      const key = String(item.targetResourceType || "");
      result[key] = (result[key] || 0) + 1;
      return result;
    }, {});

    await tx.targetSnapshotSet.create({
      data: {
        id: snapshotSetId,
        shop: canonicalShop,
        operationId: requiredText(operationId, "PREVIEW_OPERATION_ID_REQUIRED"),
        mirrorBatchId: requiredText(mirrorBatchId, "PREVIEW_MIRROR_BATCH_REQUIRED"),
        targetDefinitionHash: requiredText(targetDefinitionHash, "PREVIEW_TARGET_HASH_REQUIRED"),
        targetSetHash,
        compilerVersion: requiredText(compilerVersion, "PREVIEW_COMPILER_VERSION_REQUIRED"),
        projectionVersion: requiredText(projectionVersion, "PREVIEW_PROJECTION_VERSION_REQUIRED"),
        plannerVersion,
        status: "FROZEN",
        frozenAt: new Date(),
        expiresAt: expiry,
        targetCount: normalizedItems.length,
        productCount: counts.PRODUCT || 0,
        variantCount: counts.VARIANT || 0,
        inventoryItemCount: counts.INVENTORY_ITEM || 0,
        metafieldCount: counts.METAFIELD || 0,
        productOptionCount: counts.PRODUCT_OPTION || 0,
        collectionMembershipCount: counts.COLLECTION_MEMBERSHIP || 0,
        inventoryLevelCount: counts.INVENTORY_LEVEL || 0,
        mutationPendingCount: normalizedItems.length,
      },
    });

    if (normalizedItems.length) {
      await tx.targetSnapshotItem.createMany({
        data: normalizedItems.map((item, ordinal) => ({
          ...item,
          id: item.id || crypto.randomUUID(),
          shop: canonicalShop,
          snapshotSetId,
          operationId,
          mirrorBatchId,
          ordinal: Number.isInteger(item.ordinal) ? item.ordinal : ordinal,
        })),
      });
    }

    return tx.previewContract.create({
      data: {
        id: previewContractId,
        shop: canonicalShop,
        revision: 1,
        status: "READY_FOR_REVIEW",
        stateVersion: 0,
        contractHash: requiredText(contractHash, "PREVIEW_CONTRACT_HASH_REQUIRED"),
        payloadHash: requiredText(payloadHash, "PREVIEW_PAYLOAD_HASH_REQUIRED"),
        mirrorBatchId,
        snapshotSetId,
        expiresAt: expiry,
      },
    });
  });
}

export async function approvePreviewContract({
  shop,
  previewContractId,
  expectedStateVersion,
  approvedByActorId,
  dbClient = db,
}) {
  const canonicalShop = normalizeShopDomain(shop);
  const now = new Date();
  const result = await dbClient.previewContract.updateMany({
    where: {
      shop: canonicalShop,
      id: requiredText(previewContractId, "PREVIEW_CONTRACT_ID_REQUIRED"),
      status: "READY_FOR_REVIEW",
      stateVersion: Number(expectedStateVersion),
      expiresAt: { gt: now },
      executionId: null,
    },
    data: {
      status: "APPROVED",
      approvedAt: now,
      approvedByActorId: requiredText(approvedByActorId, "PREVIEW_APPROVER_REQUIRED"),
      stateVersion: { increment: 1 },
    },
  });
  if (result.count !== 1) throw new Error("PREVIEW_APPROVAL_CONFLICT");
  return dbClient.previewContract.findUnique({
    where: { shop_id: { shop: canonicalShop, id: previewContractId } },
  });
}

/**
 * Claims a single-use approved contract, then creates the immutable execution
 * command and queue/outbox intent through the supplied server-side callback.
 * Any callback failure rolls the claim back with the artifacts.
 */
export async function claimPreviewContractForExecution({
  shop,
  previewContractId,
  executionId,
  expectedStateVersion,
  idempotencyKeyHash,
  createExecutionArtifacts,
  dbClient = db,
}) {
  const canonicalShop = normalizeShopDomain(shop);
  if (typeof createExecutionArtifacts !== "function") {
    throw new Error("PREVIEW_EXECUTION_ARTIFACT_FACTORY_REQUIRED");
  }
  return dbClient.$transaction(async (tx) => {
    const now = new Date();
    const claimed = await tx.previewContract.updateMany({
      where: {
        shop: canonicalShop,
        id: requiredText(previewContractId, "PREVIEW_CONTRACT_ID_REQUIRED"),
        status: "APPROVED",
        stateVersion: Number(expectedStateVersion),
        expiresAt: { gt: now },
        executionId: null,
      },
      data: {
        status: "EXECUTION_CREATED",
        executionId: requiredText(executionId, "PREVIEW_EXECUTION_ID_REQUIRED"),
        stateVersion: { increment: 1 },
      },
    });
    if (claimed.count !== 1) throw new Error("PREVIEW_EXECUTION_CLAIM_CONFLICT");

    const artifacts = await createExecutionArtifacts({
      tx,
      shop: canonicalShop,
      previewContractId,
      executionId,
      idempotencyKeyHash: requiredText(idempotencyKeyHash, "PREVIEW_IDEMPOTENCY_KEY_REQUIRED"),
    });
    return { previewContractId, executionId, artifacts };
  });
}
