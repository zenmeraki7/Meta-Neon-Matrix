import shopify from "../../shopify.js";
import { getCache, setCache } from "../../utils/cacheUtils.js";

const GET_TAXONOMY_CATEGORIES_QUERY = `#graphql
  query GetTopLevelTaxonomy($first: Int!, $search: String) {
    taxonomy {
      categories(first: $first, search: $search) {
        edges {
          node {
            id
            name
            fullName
          }
        }
      }
    }
  }
`;

function assertShop(command) {
  const shop = command?.shop;
  if (!shop || typeof shop !== "string") {
    const error = new Error("Shop isolation violation");
    error.code = "FORBIDDEN";
    throw error;
  }
  return shop;
}

export class CategoryService {
  async #loadOfflineSession(shop) {
    const offlineSessionId = shopify.api.session.getOfflineId(shop);
    const session = await shopify.config.sessionStorage.loadSession(offlineSessionId);

    if (!session?.shop || session.shop !== shop) {
      const error = new Error("Authentication required");
      error.code = "UNAUTHENTICATED";
      throw error;
    }

    return session;
  }

  async getAllCategories(command) {
    const shop = assertShop(command);
    const session = await this.#loadOfflineSession(shop);

    const normalizedSearch = String(command?.search || "").trim();
    const cappedLimit = Math.min(Math.max(Number(command?.limit) || 20, 1), 50);
    const cacheKey = `${shop}:categories:${normalizedSearch || "all"}:${cappedLimit}`;

    const cached = await getCache(cacheKey);
    if (cached) {
      return {
        source: "CACHE",
        categories: Array.isArray(cached) ? cached : [],
        pageInfo: null,
      };
    }

    const client = new shopify.api.clients.Graphql({ session });
    const response = await client.query({
      data: {
        query: GET_TAXONOMY_CATEGORIES_QUERY,
        variables: {
          first: cappedLimit,
          search: normalizedSearch || null,
        },
      },
    });

    const edges = response?.body?.data?.taxonomy?.categories?.edges || [];
    const categories = edges
      .map((edge) => ({
        id: edge?.node?.id || null,
        name: edge?.node?.name || null,
        fullName: edge?.node?.fullName || null,
      }))
      .filter((item) => item.id && (item.name || item.fullName));

    await setCache(cacheKey, categories, 300);

    return {
      source: "SHOPIFY_LIVE",
      categories,
      pageInfo: null,
    };
  }
}

export default CategoryService;
