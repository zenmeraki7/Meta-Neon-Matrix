import { prisma } from "../config/database.js";
import { getCache, setCache } from "../utils/cacheUtils.js";
import shopify from "../shopify.js";

const STORE_ACCESS_CACHE_TTL_SECONDS = 300;
const STORE_TIMEZONE_CACHE_TTL_SECONDS = 24 * 60 * 60;

async function resolveShopTimezone(session) {
  try {
    const client = new shopify.api.clients.Graphql({ session });
    const response = await client.query({
      data: {
        query: `
          query GetShopTimezone {
            shop {
              ianaTimezone
            }
          }
        `,
      },
    });
    return response?.body?.data?.shop?.ianaTimezone || "UTC";
  } catch {
    return "UTC";
  }
}

async function resolveShopTimezoneCached({ shop, session }) {
  const timezoneCacheKey = `${shop}:storeTimezone`;
  const cachedTimezone = await getCache(timezoneCacheKey);
  if (cachedTimezone) {
    return String(cachedTimezone);
  }
  const timezone = await resolveShopTimezone(session);
  await setCache(timezoneCacheKey, timezone, STORE_TIMEZONE_CACHE_TTL_SECONDS);
  return timezone;
}

export async function getStoreAccessDto({ session }) {
  const shop = String(session?.shop || "").trim();
  if (!shop) {
    const error = new Error("UNAUTHENTICATED");
    error.code = "UNAUTHENTICATED";
    throw error;
  }

  const cacheKey = `${shop}:storeDetails`;
  const cached = await getCache(cacheKey);
  if (cached) {
    return cached;
  }

  const store = await prisma.store.findUnique({
    where: { shopUrl: shop },
    select: {
      shopUrl: true,
      isCreditAvailable: true,
      isProductInitialySyning: true,
    },
  });

  if (!store) {
    const error = new Error("NOT_FOUND");
    error.code = "NOT_FOUND";
    throw error;
  }

  const [totalbulkEditCount, totalSyncCount, shopTimezone] = await Promise.all([
    prisma.editHistory.count({
      where: {
        shop,
        status: {
          in: ["completed", "Undo completed"],
        },
      },
    }),
    prisma.syncHistory.count({
      where: {
        shop,
        status: "completed",
      },
    }),
    resolveShopTimezoneCached({ shop, session }),
  ]);

  const dto = {
    message: "fetched store access successfully",
    shopUrl: store.shopUrl,
    shopTimezone,
    totalbulkEditCount,
    totalSyncCount,
    isProductInitialySyning: store.isProductInitialySyning,
    isCreditAvailable: store.isCreditAvailable || false,
  };

  await setCache(cacheKey, dto, STORE_ACCESS_CACHE_TTL_SECONDS);
  return dto;
}
