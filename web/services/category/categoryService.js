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

export class CategoryService {
  async getAllCategories({ session, search = "", isNameOnly = false, limit = 20 }) {
    const shop = session.shop;
    const normalizedSearch = String(search || "").trim();
    const cappedLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const cacheKey = `${shop}:categories:${isNameOnly ? "name" : "full"}:${normalizedSearch || "all"}:${cappedLimit}`;

    const cached = await getCache(cacheKey);
    if (cached) {
      return cached;
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
    const categories = edges.map((edge) => ({
      id: edge.node.id,
      value: edge.node.id,
      title: isNameOnly ? edge.node.name : edge.node.fullName,
      label: isNameOnly ? edge.node.name : edge.node.fullName,
    }));

    await setCache(cacheKey, categories, 300);
    return categories;
  }
}

export default CategoryService;
