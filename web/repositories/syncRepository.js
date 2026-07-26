import { prisma } from "../config/database.js";
import { requireShopScope } from "../utils/shopScope.js";
import { SYNC_OPERATION_TYPE, SYNC_STATUS } from "../constants/syncConstants.js";

const COMPLETED_EDIT_STATUS = "COMPLETED";
const MAX_MIRROR_BATCH_ID_LENGTH = 128;
const MIRROR_BATCH_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

function buildRepositoryError(message, code = "VALIDATION_FAILED") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateMirrorBatchId(value) {
  if (typeof value !== "string") {
    throw buildRepositoryError("Invalid product mirror batch ID");
  }

  const mirrorBatchId = value.trim();

  if (
    !mirrorBatchId ||
    mirrorBatchId.length > MAX_MIRROR_BATCH_ID_LENGTH ||
    !MIRROR_BATCH_ID_PATTERN.test(mirrorBatchId)
  ) {
    throw buildRepositoryError("Invalid product mirror batch ID");
  }

  return mirrorBatchId;
}

export async function getActiveProductCountByShop(shop) {
  const resolvedShop = requireShopScope(shop);

  return prisma.$transaction(
    async (tx) => {
      const store = await tx.store.findUnique({
        where: {
          shopUrl: resolvedShop,
        },
        select: {
          currentProductMirrorBatchId: true,
        },
      });

      if (!store) {
        throw buildRepositoryError("Store was not found", "STORE_NOT_FOUND");
      }

      if (!store.currentProductMirrorBatchId) {
        return Object.freeze({
          ready: false,
          count: 0,
          mirrorBatchId: null,
        });
      }

      const mirrorBatchId = validateMirrorBatchId(
        store.currentProductMirrorBatchId,
      );

      const count = await tx.product.count({
        where: {
          shop: resolvedShop,
          mirrorBatchId,
        },
      });

      return Object.freeze({
        ready: true,
        count,
        mirrorBatchId,
      });
    },
    {
      isolationLevel: "RepeatableRead",
    },
  );
}

export async function getProductCountForBatch({
  shop,
  mirrorBatchId,
  requireActive = false,
}) {
  const resolvedShop = requireShopScope(shop);
  const safeMirrorBatchId = validateMirrorBatchId(mirrorBatchId);

  return prisma.$transaction(
    async (tx) => {
      if (requireActive) {
        const store = await tx.store.findUnique({
          where: { shopUrl: resolvedShop },
          select: { currentProductMirrorBatchId: true },
        });

        if (!store) {
          throw buildRepositoryError("Store was not found", "STORE_NOT_FOUND");
        }

        if (store.currentProductMirrorBatchId !== safeMirrorBatchId) {
          throw buildRepositoryError(
            "Product mirror batch is not active for this shop",
            "MIRROR_BATCH_NOT_ACTIVE",
          );
        }
      }

      const batch = await tx.mirrorBatch.findFirst({
        where: {
          shop: resolvedShop,
          id: safeMirrorBatchId,
          mirrorResourceType: "PRODUCT_CATALOG",
        },
        select: {
          id: true,
        },
      });

      if (!batch) {
        throw buildRepositoryError(
          "Product mirror batch was not found",
          "MIRROR_BATCH_NOT_FOUND",
        );
      }

      return tx.product.count({
        where: {
          shop: resolvedShop,
          mirrorBatchId: safeMirrorBatchId,
        },
      });
    },
    {
      isolationLevel: "RepeatableRead",
    },
  );
}

export async function getLatestCompletedProductSyncByShop(shop) {
  const resolvedShop = requireShopScope(shop);

  return prisma.syncHistory.findFirst({
    where: {
      shop: resolvedShop,
      operationType: SYNC_OPERATION_TYPE.PRODUCT,
      status: SYNC_STATUS.COMPLETED,
    },
    orderBy: [
      {
        completedAt: {
          sort: "desc",
          nulls: "last",
        },
      },
      {
        id: "desc",
      },
    ],
    select: {
      id: true,
      status: true,
      updatedAt: true,
      completedAt: true,
      recordCount: true,
      mirrorBatchId: true,
    },
  });
}

export async function countCompletedBulkEditsByShop(shop) {
  const resolvedShop = requireShopScope(shop);

  return prisma.editHistory.count({
    where: {
      shop: resolvedShop,
      statusNormalized: COMPLETED_EDIT_STATUS,
    },
  });
}

export async function countCompletedProductSyncsByShop(shop) {
  const resolvedShop = requireShopScope(shop);

  return prisma.syncHistory.count({
    where: {
      shop: resolvedShop,
      operationType: SYNC_OPERATION_TYPE.PRODUCT,
      status: SYNC_STATUS.COMPLETED,
    },
  });
}

export async function getLatestProductSyncInternalByShop(shop) {
  const resolvedShop = requireShopScope(shop);

  return prisma.syncHistory.findFirst({
    where: {
      shop: resolvedShop,
      operationType: SYNC_OPERATION_TYPE.PRODUCT,
    },
    orderBy: [
      {
        createdAt: "desc",
      },
      {
        id: "desc",
      },
    ],
    select: {
      id: true,
      shopifyBulkOperationId: true,
      mirrorBatchId: true,
      status: true,
      stage: true,
      recordCount: true,
      updatedAt: true,
      completedAt: true,
      errorMessage: true,
      isInitialProductSync: true,
    },
  });
}

export const getLatestProductSyncByShop = getLatestProductSyncInternalByShop;

export async function getLatestProductSyncSummaryByShop(shop) {
  const resolvedShop = requireShopScope(shop);

  return prisma.syncHistory.findFirst({
    where: {
      shop: resolvedShop,
      operationType: SYNC_OPERATION_TYPE.PRODUCT,
    },
    orderBy: [
      {
        createdAt: "desc",
      },
      {
        id: "desc",
      },
    ],
    select: {
      id: true,
      status: true,
      stage: true,
      updatedAt: true,
      completedAt: true,
      isInitialProductSync: true,
    },
  });
}