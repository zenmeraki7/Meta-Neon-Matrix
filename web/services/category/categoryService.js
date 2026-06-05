import { GetTaxonomyCategories } from "../../graphql/taxonomy.js";
import { requireShopScope } from "../../utils/shopScope.js";

const TAXONOMY_CACHE_TTL_SECONDS = 300;
const TAXONOMY_REFRESH_PAGE_SIZE = 250;
const TAXONOMY_REFRESH_MAX_PAGES = 80;
const TAXONOMY_UPSERT_CHUNK_SIZE = 500;

let taxonomyRefreshInFlight = null;

async function defaultGetCache(key) {
  const { getCache } = await import("../../utils/cacheUtils.js");
  return getCache(key);
}

async function defaultSetCache(key, value, ttlSeconds) {
  const { setCache } = await import("../../utils/cacheUtils.js");
  return setCache(key, value, ttlSeconds);
}

async function defaultLoadDb() {
  const { db } = await import("../../repositories/repositoryDb.js");
  return db;
}

async function defaultLoadShopifyApi() {
  const { default: shopify } = await import("../../shopify.js");
  return shopify.api;
}

async function defaultAssertEntitlement(command) {
  const { assertFeatureEntitlement } = await import(
    "../entitlement/featureEntitlementService.js"
  );
  return assertFeatureEntitlement(command);
}

function normalizeSearch(search = "") {
  return String(search || "").trim();
}

function parsePaginationCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  const offset = Number.parseInt(String(cursor), 10);
  if (!Number.isInteger(offset) || offset < 0) {
    const error = new Error("Invalid category cursor");
    error.code = "VALIDATION_ERROR";
    throw error;
  }
  return offset;
}

function buildSearchText(category) {
  return `${category.name || ""} ${category.fullName || ""}`.toLowerCase();
}

function toCategoryRecord(node) {
  const id = String(node?.id || "").trim();
  const name = String(node?.name || "").trim();
  const fullName = String(node?.fullName || node?.name || "").trim();
  if (!id || (!name && !fullName)) return null;
  return {
    id,
    name: name || fullName,
    fullName: fullName || name,
  };
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export class CategoryService {
  constructor({
    db = null,
    shopifyApi = null,
    loadDb = defaultLoadDb,
    loadShopifyApi = defaultLoadShopifyApi,
    getCache = defaultGetCache,
    setCache = defaultSetCache,
    assertEntitlement = defaultAssertEntitlement,
  } = {}) {
    this.db = db;
    this.shopifyApi = shopifyApi;
    this.loadDb = loadDb;
    this.loadShopifyApi = loadShopifyApi;
    this.getCache = getCache;
    this.setCache = setCache;
    this.assertEntitlement = assertEntitlement;
  }

  async getAllCategories(command = {}) {
    const shop = requireShopScope(command.shop);
    const normalizedSearch = normalizeSearch(command.search);
    const limit = Math.min(Math.max(Number(command.limit) || 20, 1), 50);
    const offset = parsePaginationCursor(command.cursor);
    const db = await this.#resolveDb();

    let total = await db.shopifyTaxonomyCategory.count({
      where: this.#buildWhere(normalizedSearch),
    });
    if (total === 0 && offset === 0) {
      await this.#refreshMirrorOnce({
        shop,
        subscription: command.subscription || null,
      });
      total = await db.shopifyTaxonomyCategory.count({
        where: this.#buildWhere(normalizedSearch),
      });
    }

    const cacheKey = `${shop}:taxonomyCategories:v1:${normalizedSearch || "all"}`;
    const cached = await this.getCache(cacheKey);
    let allCategories;
    if (cached) {
      if (!Array.isArray(cached)) {
        throw new Error("CATEGORY_CACHE_CORRUPT");
      }
      allCategories = cached;
    } else {
      allCategories = await db.shopifyTaxonomyCategory.findMany({
        where: this.#buildWhere(normalizedSearch),
        select: {
          id: true,
          name: true,
          fullName: true,
        },
        orderBy: [{ fullName: "asc" }, { id: "asc" }],
      });
      await this.setCache(cacheKey, allCategories, TAXONOMY_CACHE_TTL_SECONDS);
    }

    const categories = allCategories.slice(offset, offset + limit);
    const nextOffset = offset + categories.length;
    return {
      source: cached ? "MIRROR_CACHE" : "MIRROR",
      categories,
      pageInfo: {
        hasNextPage: nextOffset < allCategories.length,
        nextCursor: nextOffset < allCategories.length ? String(nextOffset) : null,
        totalCount: allCategories.length || total,
      },
    };
  }

  async refreshTaxonomyMirror(command = {}) {
    const shop = requireShopScope(command.shop);
    await this.#refreshMirrorOnce({
      shop,
      subscription: command.subscription || null,
    });
    return { success: true };
  }

  #buildWhere(search) {
    if (!search) return {};
    return {
      searchText: {
        contains: search.toLowerCase(),
        mode: "insensitive",
      },
    };
  }

  async #refreshMirrorOnce({ shop, subscription }) {
    if (!taxonomyRefreshInFlight) {
      taxonomyRefreshInFlight = this.#refreshMirror({ shop, subscription }).finally(() => {
        taxonomyRefreshInFlight = null;
      });
    }
    return taxonomyRefreshInFlight;
  }

  async #refreshMirror({ shop, subscription }) {
    await this.assertEntitlement({
      shop,
      feature: "COLLECTION_LIVE_LOOKUP",
      subscription,
    });
    const db = await this.#resolveDb();
    const shopifyApi = await this.#resolveShopifyApi();
    const session = await this.#loadOfflineSession(shop, shopifyApi);
    const client = new shopifyApi.clients.Graphql({ session });
    const categories = [];
    let after = null;

    try {
      for (let page = 0; page < TAXONOMY_REFRESH_MAX_PAGES; page += 1) {
        const response = await client.query({
          data: {
            query: GetTaxonomyCategories,
            variables: {
              first: TAXONOMY_REFRESH_PAGE_SIZE,
              after,
            },
          },
        });

        if (response?.body?.errors?.length) {
          const error = new Error(response.body.errors[0]?.message || "SHOPIFY_TAXONOMY_ERROR");
          error.code = "SHOPIFY_GRAPHQL_ERROR";
          throw error;
        }

        const connection = response?.body?.data?.taxonomy?.categories;
        const edges = Array.isArray(connection?.edges) ? connection.edges : [];
        categories.push(
          ...edges
            .map(({ node }) => toCategoryRecord(node))
            .filter(Boolean),
        );
        if (!connection?.pageInfo?.hasNextPage) break;
        after = connection.pageInfo.endCursor || edges.at(-1)?.cursor || null;
        if (!after) break;
      }
    } catch (error) {
      const message = String(error?.message || "").toLowerCase();
      if (
        message.includes("throttle") ||
        message.includes("rate") ||
        message.includes("too many requests")
      ) {
        const throttleError = new Error("Shopify API throttled taxonomy request");
        throttleError.code = "RATE_LIMITED";
        throw throttleError;
      }
      throw new Error("SHOPIFY_TAXONOMY_REFRESH_FAILED", { cause: error });
    }

    for (const rows of chunk(categories, TAXONOMY_UPSERT_CHUNK_SIZE)) {
      await Promise.all(
        rows.map((category) =>
          db.shopifyTaxonomyCategory.upsert({
            where: { id: category.id },
            create: {
              ...category,
              searchText: buildSearchText(category),
            },
            update: {
              name: category.name,
              fullName: category.fullName,
              searchText: buildSearchText(category),
            },
          }),
        ),
      );
    }
  }

  async #loadOfflineSession(shop, shopifyApi) {
    const offlineSessionId = shopifyApi.session.getOfflineId(shop);
    const session = await shopifyApi.config.sessionStorage.loadSession(offlineSessionId);
    if (!session?.shop || session.shop !== shop) {
      const error = new Error("Authentication required");
      error.code = "UNAUTHENTICATED";
      throw error;
    }
    return session;
  }

  async #resolveDb() {
    if (this.db) return this.db;
    this.db = await this.loadDb();
    return this.db;
  }

  async #resolveShopifyApi() {
    if (this.shopifyApi) return this.shopifyApi;
    this.shopifyApi = await this.loadShopifyApi();
    return this.shopifyApi;
  }
}

export default CategoryService;
