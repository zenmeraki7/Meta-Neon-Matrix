import fetch from "node-fetch";
import readline from "node:readline";
import { Readable } from "node:stream";
import { shopifyGraphQL } from "./graphql.js";

/**
 * Converts a Shopify GID to BigInt ID.
 * @param {string} gid
 * @returns {bigint}
 * @throws {Error}
 */
export const stripGid = (gid) => BigInt(String(gid || "").split("/").pop());

const BULK_PRODUCTS_QUERY = `#graphql
  mutation bulkOperationRunQuery($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`;

const BULK_PRODUCTS_INNER_QUERY = `
{
  products {
    edges {
      node {
        id title handle status vendor productType tags createdAt updatedAt
        variants {
          edges {
            node {
              id title sku price inventoryQuantity position createdAt updatedAt
              selectedOptions { name value }
            }
          }
        }
      }
    }
  }
}
`;

const CURRENT_BULK_OPERATION_QUERY = `#graphql
  query currentBulkOperation {
    currentBulkOperation {
      id
      status
      url
      objectCount
    }
  }
`;

/**
 * Starts full product bulk sync query.
 * @param {string} shop
 * @param {string} accessToken
 * @returns {Promise<bigint>}
 * @throws {Error}
 */
export async function startBulkProductSync(shop, accessToken) {
  const current = await shopifyGraphQL({
    shop,
    accessToken,
    query: CURRENT_BULK_OPERATION_QUERY,
  });
  const running = current?.currentBulkOperation;
  if (running && ["CREATED", "RUNNING"].includes(String(running.status || "").toUpperCase())) {
    throw new Error(`Another bulk operation is already running: ${running.id}`);
  }

  const data = await shopifyGraphQL({
    shop,
    accessToken,
    query: BULK_PRODUCTS_QUERY,
    variables: { query: BULK_PRODUCTS_INNER_QUERY },
  });
  const userErrors = data?.bulkOperationRunQuery?.userErrors || [];
  if (Array.isArray(userErrors) && userErrors.length > 0) {
    throw new Error(`bulkOperationRunQuery userErrors: ${JSON.stringify(userErrors)}`);
  }
  const gid = data?.bulkOperationRunQuery?.bulkOperation?.id;
  if (!gid) throw new Error("bulkOperationRunQuery did not return operation id");
  return stripGid(gid);
}

/**
 * Polls current bulk operation.
 * @param {string} shop
 * @param {string} accessToken
 * @param {bigint|string|number} shopifyBulkOperationId
 * @returns {Promise<{ status: string, url: string|null, objectCount: number }>}
 * @throws {Error}
 */
export async function pollBulkOperation(shop, accessToken, shopifyBulkOperationId) {
  const current = await shopifyGraphQL({
    shop,
    accessToken,
    query: CURRENT_BULK_OPERATION_QUERY,
  });
  const op = current?.currentBulkOperation || null;
  if (!op) {
    return { status: "CANCELED", url: null, objectCount: 0 };
  }
  const opId = stripGid(op.id);
  if (opId !== BigInt(shopifyBulkOperationId)) {
    return { status: "CANCELED", url: null, objectCount: 0 };
  }
  return {
    status: String(op.status || "").toUpperCase(),
    url: op.url || null,
    objectCount: Number(op.objectCount || 0),
  };
}

/**
 * Streams Shopify JSONL and rebuilds product/variant parent-child structure.
 * @param {string} url
 * @returns {Promise<Array<object>>}
 * @throws {Error}
 */
export async function downloadAndParseJSONL(url) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download JSONL: ${response.status}`);
  }

  const stream = Readable.fromWeb(response.body);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const byProductId = new Map();
  const variantBuffer = new Map();

  for await (const line of rl) {
    const text = String(line || "").trim();
    if (!text) continue;
    const row = JSON.parse(text);
    const parentId = row.__parentId ? String(row.__parentId) : null;

    if (!parentId && row.id && row.handle !== undefined) {
      const productId = stripGid(row.id);
      const product = {
        id: productId,
        title: String(row.title || ""),
        handle: String(row.handle || ""),
        status: String(row.status || ""),
        vendor: row.vendor ?? null,
        productType: row.productType ?? null,
        tags: Array.isArray(row.tags) ? row.tags : [],
        shopifyCreatedAt: row.createdAt || null,
        shopifyUpdatedAt: row.updatedAt || null,
        variants: [],
      };
      byProductId.set(productId.toString(), product);
      const pending = variantBuffer.get(row.id) || [];
      if (pending.length) {
        product.variants.push(...pending);
        variantBuffer.delete(row.id);
      }
      continue;
    }

    if (parentId && row.id) {
      const variantId = stripGid(row.id);
      const productId = stripGid(parentId);
      const variant = {
        id: variantId,
        productId,
        title: String(row.title || ""),
        sku: row.sku ?? null,
        price: String(row.price || "0"),
        inventoryQuantity: Number(row.inventoryQuantity || 0),
        position: Number(row.position || 0),
        optionValues: Array.isArray(row.selectedOptions) ? row.selectedOptions : [],
        shopifyCreatedAt: row.createdAt || null,
        shopifyUpdatedAt: row.updatedAt || null,
      };
      const product = byProductId.get(productId.toString());
      if (product) {
        product.variants.push(variant);
      } else {
        const pending = variantBuffer.get(parentId) || [];
        pending.push(variant);
        variantBuffer.set(parentId, pending);
      }
    }
  }

  return Array.from(byProductId.values());
}

