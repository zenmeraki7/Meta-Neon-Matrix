import { prisma } from "../config/database.js";

export async function getSyncCursor(shopId, resourceType) {
  const shop = String(shopId || "").trim();
  const resource = String(resourceType || "").trim();
  if (!shop || !resource) return null;

  const row = await prisma.syncCursor.findUnique({
    where: {
      shopId_resourceType: {
        shopId: shop,
        resourceType: resource,
      },
    },
    select: {
      cursorValue: true,
    },
  });
  return row?.cursorValue || null;
}

export async function setSyncCursor(shopId, resourceType, cursorValue) {
  const shop = String(shopId || "").trim();
  const resource = String(resourceType || "").trim();
  const cursor = cursorValue == null ? null : String(cursorValue);
  if (!shop || !resource) {
    throw new Error("setSyncCursor requires shopId and resourceType");
  }

  return prisma.syncCursor.upsert({
    where: {
      shopId_resourceType: {
        shopId: shop,
        resourceType: resource,
      },
    },
    create: {
      shopId: shop,
      resourceType: resource,
      cursorValue: cursor,
      lastSyncedAt: new Date(),
    },
    update: {
      cursorValue: cursor,
      lastSyncedAt: new Date(),
    },
  });
}

