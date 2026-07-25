import { prisma } from "../config/database.js";

async function ensureSyncCursorShop(shopDomain) {
  const store = await prisma.store.findUnique({
    where: { shopUrl: shopDomain },
    select: { shopUrl: true },
  });

  if (!store) {
    throw new Error("SYNC_CURSOR_STORE_NOT_FOUND");
  }
}

export async function getSyncCursor(shopDomain, syncResourceType) {
  const shop = String(shopDomain || "").trim();
  const resource = String(syncResourceType || "").trim();
  if (!shop || !resource) return null;

  const row = await prisma.syncCursor.findUnique({
    where: {
      shopDomain_syncResourceType: {
        shopDomain: shop,
        syncResourceType: resource,
      },
    },
    select: {
      cursorValue: true,
    },
  });
  return row?.cursorValue || null;
}

export async function setSyncCursor(shopDomain, syncResourceType, cursorValue) {
  const shop = String(shopDomain || "").trim();
  const resource = String(syncResourceType || "").trim();
  const cursor = cursorValue == null ? null : String(cursorValue);
  if (!shop || !resource) {
    throw new Error("setSyncCursor requires shopDomain and syncResourceType");
  }

  await ensureSyncCursorShop(shop);

  return prisma.syncCursor.upsert({
    where: {
      shopDomain_syncResourceType: {
        shopDomain: shop,
        syncResourceType: resource,
      },
    },
    create: {
      shopDomain: shop,
      syncResourceType: resource,
      cursorValue: cursor,
      cursorAdvancedAt: new Date(),
    },
    update: {
      cursorValue: cursor,
      cursorAdvancedAt: new Date(),
    },
  });
}
