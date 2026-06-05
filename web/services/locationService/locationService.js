import crypto from "crypto";
import { GetLocations } from "../../graphql/location.js";
import { db as defaultDb } from "../../repositories/repositoryDb.js";
import shopify from "../../shopify.js";
import { getCache, setCache } from "../../utils/cacheUtils.js";
import { requireShopScope } from "../../utils/shopScope.js";

const LOCATION_CACHE_TTL_SECONDS = 300;
const LOCATION_PAGE_SIZE = 250;
const MAX_LOCATION_PAGES = 20;

function normalizeSearch(search = "") {
  return String(search || "").trim();
}

function buildSearchCachePart(search) {
  const normalized = normalizeSearch(search).toLowerCase();
  if (!normalized) return "all";
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function toLocationOption(location) {
  return {
    id: location.id,
    title: location.name,
  };
}

function extractLocationsConnection(response) {
  return response?.body?.data?.locations || response?.data?.locations || null;
}

export class LocationService {
  constructor({ db = defaultDb, shopifyApi = shopify.api } = {}) {
    if (!db) throw new Error("LOCATION_DB_REQUIRED");
    if (!shopifyApi) throw new Error("LOCATION_SHOPIFY_API_REQUIRED");
    this.db = db;
    this.shopifyApi = shopifyApi;
  }

  async getLocationsByShop(shop, { search = "" } = {}) {
    const scopedShop = requireShopScope(shop);
    const normalizedSearch = normalizeSearch(search);
    const cacheKey = `${scopedShop}:locations:mirror:v1:${buildSearchCachePart(normalizedSearch)}`;
    const cachedData = await getCache(cacheKey);
    if (cachedData) return cachedData;

    try {
      const rows = await this.db.location.findMany({
        where: {
          shop: scopedShop,
          ...(normalizedSearch
            ? {
                name: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              }
            : {}),
        },
        select: {
          id: true,
          name: true,
        },
        orderBy: { name: "asc" },
      });
      const locations = rows.map(toLocationOption);
      await setCache(cacheKey, locations, LOCATION_CACHE_TTL_SECONDS);
      return locations;
    } catch (error) {
      throw new Error("Error fetching mirrored locations from database", { cause: error });
    }
  }

  async fetchLocations({ session, search = "", shop = null } = {}) {
    const sessionShop = requireShopScope(session?.shop, "session.shop");
    if (shop && requireShopScope(shop) !== sessionShop) {
      throw new Error("LOCATION_SESSION_SHOP_MISMATCH");
    }

    const normalizedSearch = normalizeSearch(search);
    const cacheKey = `${sessionShop}:locations:shopify:v1:${buildSearchCachePart(normalizedSearch)}`;
    const cachedData = await getCache(cacheKey);
    if (cachedData) return cachedData;

    try {
      const client = new this.shopifyApi.clients.Graphql({ session });
      const locations = [];
      let after = null;

      for (let page = 0; page < MAX_LOCATION_PAGES; page += 1) {
        const response = await client.query({
          data: {
            query: GetLocations,
            variables: {
              first: LOCATION_PAGE_SIZE,
              after,
              search: normalizedSearch || null,
            },
          },
        });
        const connection = extractLocationsConnection(response);
        const edges = Array.isArray(connection?.edges) ? connection.edges : [];
        locations.push(
          ...edges
            .map(({ node }) => ({
              id: String(node?.id || "").trim(),
              title: String(node?.name || "").trim(),
              active: node?.isActive ?? null,
            }))
            .filter((location) => location.id && location.title),
        );

        if (!connection?.pageInfo?.hasNextPage) break;
        after = connection.pageInfo.endCursor || edges.at(-1)?.cursor || null;
        if (!after) break;
      }

      await this.#upsertLocationMirror(sessionShop, locations);
      const result = locations.map(({ id, title }) => ({ id, title }));
      await setCache(cacheKey, result, LOCATION_CACHE_TTL_SECONDS);
      return result;
    } catch (error) {
      throw new Error("Error fetching locations from Shopify", { cause: error });
    }
  }

  async #upsertLocationMirror(shop, locations) {
    if (!locations.length) return;
    const now = new Date();
    await Promise.all(
      locations.map((location) =>
        this.db.location.upsert({
          where: {
            shop_id: {
              shop,
              id: location.id,
            },
          },
          create: {
            shop,
            id: location.id,
            name: location.title,
            active: location.active,
            lastSyncedAt: now,
          },
          update: {
            name: location.title,
            active: location.active,
            lastSyncedAt: now,
          },
        }),
      ),
    );
  }
}
