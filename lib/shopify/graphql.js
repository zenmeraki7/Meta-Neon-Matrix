import fetch from "node-fetch";

export const API_VERSION = "2025-01";

/**
 * Executes Shopify Admin GraphQL query.
 * @param {{ shop: string, accessToken: string, query: string, variables?: object }} params
 * @returns {Promise<object>}
 * @throws {Error}
 */
export async function shopifyGraphQL({
  shop,
  accessToken,
  query,
  variables = {},
}) {
  const resolvedShop = String(shop || "").trim();
  const token = String(accessToken || "").trim();
  const gql = String(query || "").trim();
  if (!resolvedShop) throw new Error("shopifyGraphQL requires shop");
  if (!token) throw new Error("shopifyGraphQL requires accessToken");
  if (!gql) throw new Error("shopifyGraphQL requires query");

  const response = await fetch(
    `https://${resolvedShop}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({
        query: gql,
        variables,
      }),
    },
  );

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`Shopify GraphQL HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }

  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(payload.errors)}`);
  }

  return payload?.data || {};
}

