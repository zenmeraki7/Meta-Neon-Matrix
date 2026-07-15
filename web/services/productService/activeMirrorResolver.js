import { db } from "../../repositories/repositoryDb.js";

export function buildTargetingRequiresSyncError(
  message = "Refresh product data before previewing this edit.",
) {
  const error = new Error(message);
  error.code = "TARGETING_REQUIRES_SYNC";
  error.action = "SYNC_PRODUCTS";
  return error;
}

export async function resolveHealthyActiveProductMirror(shop) {
  const normalizedShop = String(shop || "").trim();
  if (!normalizedShop) throw buildTargetingRequiresSyncError();

  const store = await db.store.findUnique({
    where: { shopUrl: normalizedShop },
    select: {
      activeMirrorBatchId: true,
      mirrorHealthState: true,
      repairRequired: true,
    },
  });

  if (
    !store?.activeMirrorBatchId ||
    store.mirrorHealthState !== "HEALTHY" ||
    store.repairRequired
  ) {
    throw buildTargetingRequiresSyncError();
  }

  const activeBatch = await db.mirrorBatch.findFirst({
    where: {
      id: store.activeMirrorBatchId,
      shop: normalizedShop,
      resourceType: "PRODUCT_CATALOG",
      status: "ACTIVE",
    },
    select: { id: true },
  });

  if (!activeBatch) throw buildTargetingRequiresSyncError();

  return {
    mirrorBatchId: activeBatch.id,
    mirrorState: store,
  };
}
