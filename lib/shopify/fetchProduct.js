import { shopifyGraphQL } from "./graphql.js";
import { stripGid } from "./bulkOperations.js";

const FETCH_PRODUCT_QUERY = `#graphql
  query FetchProduct($id: ID!) {
    node(id: $id) {
      ... on Product {
        id
        title
        handle
        status
        vendor
        productType
        tags
        createdAt
        updatedAt
        variants(first: 250) {
          edges {
            node {
              id
              title
              sku
              price
              inventoryQuantity
              position
              createdAt
              updatedAt
              selectedOptions {
                name
                value
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Fetches one product and variants from Shopify.
 * WARNING: variants are capped at first: 250 in this query.
 * @param {string} shop
 * @param {string} accessToken
 * @param {bigint|string|number} productId
 * @returns {Promise<object|null>}
 * @throws {Error}
 */
export async function fetchProduct(shop, accessToken, productId) {
  const productNumericId = BigInt(productId);
  const productGid = `gid://shopify/Product/${productNumericId.toString()}`;

  const data = await shopifyGraphQL({
    shop,
    accessToken,
    query: FETCH_PRODUCT_QUERY,
    variables: { id: productGid },
  });
  const node = data?.node || null;
  if (!node || !node.id) return null;

  const variants = Array.isArray(node?.variants?.edges)
    ? node.variants.edges.map((edge) => edge?.node).filter(Boolean)
    : [];

  return {
    id: stripGid(node.id),
    title: String(node.title || ""),
    handle: String(node.handle || ""),
    status: String(node.status || ""),
    vendor: node.vendor ?? null,
    productType: node.productType ?? null,
    tags: Array.isArray(node.tags) ? node.tags : [],
    shopifyCreatedAt: node.createdAt || null,
    shopifyUpdatedAt: node.updatedAt || null,
    variants: variants.map((variant) => ({
      id: stripGid(variant.id),
      productId: stripGid(node.id),
      title: String(variant.title || ""),
      sku: variant.sku ?? null,
      price: String(variant.price || "0"),
      inventoryQuantity: Number(variant.inventoryQuantity || 0),
      position: Number(variant.position || 0),
      optionValues: Array.isArray(variant.selectedOptions) ? variant.selectedOptions : [],
      shopifyCreatedAt: variant.createdAt || null,
      shopifyUpdatedAt: variant.updatedAt || null,
    })),
  };
}

