import { Worker, type ConnectionOptions } from "bullmq";
import { prisma } from "../config/database.js";
import { connection as redis } from "../config/redis.js";
import { saveBeforeSnapshotOnce } from "../lib/snapshot.server.js";
import { shopifyGraphqlWithBackoff } from "../lib/shopifyGraphqlBackoff.server.js";
import { getAdminGraphqlForShop } from "../lib/shopifyAdmin.server.js";
import {
  recomputeApplyRequestStatus,
  transitionBulkApplyItemStatus,
  transitionBulkApplyItemsStatus,
} from "../lib/recomputeApplyStatus.server.js";

const MAX_ITEM_ATTEMPTS = 5;
const MAX_ERROR_CHARS = 2_000;
const STUCK_AFTER_MS = 10 * 60 * 1000;

const PRODUCT_APPLY_SNAPSHOT_QUERY = `#graphql
  query ProductApplySnapshot($productId: ID!) {
    product(id: $productId) {
      id
      title
      descriptionHtml
      handle
      productType
      vendor
      status
      tags
      seo {
        title
        description
      }
      metafields(first: 100) {
        nodes {
          id
          namespace
          key
          type
          value
        }
      }
    }
  }
`;

const PRODUCT_AND_METAFIELDS_UPDATE_MUTATION = `#graphql
  mutation ProductAndMetafieldsUpdate($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

type AdminGraphql = Awaited<ReturnType<typeof getAdminGraphqlForShop>>;

function throwForGraphqlErrors(result: any) {
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  if (errors.length > 0) {
    throw new Error(errors[0]?.message || "SHOPIFY_GRAPHQL_ERROR");
  }
}

async function fetchCurrentShopifyProductState({
  adminGraphql,
  productId,
}: {
  adminGraphql: AdminGraphql;
  productId: string;
}) {
  const result = await shopifyGraphqlWithBackoff({
    adminGraphql,
    query: PRODUCT_APPLY_SNAPSHOT_QUERY,
    variables: { productId },
  });

  throwForGraphqlErrors(result);

  if (!result?.data?.product) {
    throw new Error("SHOPIFY_PRODUCT_NOT_FOUND");
  }

  return result.data.product;
}

function requireProductUpdateFields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("TRUSTED_OUTPUT_FIELDS_INVALID");
  }

  return value as Record<string, unknown>;
}

async function recoverStuckApplyItems(shop: string, requestId: string) {
  const cutoff = new Date(Date.now() - STUCK_AFTER_MS);
  await prisma.$transaction(async (tx) => {
    const changed = await tx.bulkApplyItem.updateMany({
      where: { shop, requestId, status: "APPLYING", updatedAt: { lt: cutoff } },
      data: {
        status: "FAILED",
        error: "Recovered stuck APPLYING item",
        finishedAt: new Date(),
      },
    });
    if (changed.count > 0) {
      await recomputeApplyRequestStatus({ shop, applyRequestId: requestId, db: tx });
    }
  });
}

async function isCancelled(shop: string, applyRequestId: string) {
  const request = await prisma.bulkApplyRequest.findFirst({
    where: { id: applyRequestId, shop },
    select: { status: true },
  });

  return request?.status === "CANCELLED";
}

async function failItemPermanently(
  shop: string,
  applyRequestId: string,
  itemId: string,
  error: unknown
) {
  await transitionBulkApplyItemStatus({
    shop,
    applyRequestId,
    itemId,
    allowedFrom: ["APPLYING"],
    to: "FAILED_PERMANENT",
    data: {
      error: String(error instanceof Error ? error.message : error).slice(
        0,
        MAX_ERROR_CHARS
      ),
      finishedAt: new Date(),
    },
  });
}

export const applyWorker = new Worker(
  "bulk-apply",
  async (job) => {
    const { shop, bulkApplyJobId, applyRequestId } = job.data;

    await prisma.bulkApplyRequest.updateMany({
      where: { id: applyRequestId, shop },
      data: {
        status: "RUNNING",
        startedAt: new Date(),
      },
    });

    await recoverStuckApplyItems(shop, applyRequestId);

    const adminGraphql = await getAdminGraphqlForShop(shop);

    while (true) {
      if (await isCancelled(shop, applyRequestId)) {
        await transitionBulkApplyItemsStatus({
          shop,
          applyRequestId,
          allowedFrom: ["PENDING", "FAILED"],
          to: "CANCELLED",
          data: {
            finishedAt: new Date(),
          },
        });
        return { cancelled: true };
      }

      const item = await prisma.bulkApplyItem.findFirst({
        where: {
          shop,
          requestId: applyRequestId,
          status: { in: ["PENDING", "FAILED"] },
          attempt: { lt: MAX_ITEM_ATTEMPTS },
        },
        orderBy: { createdAt: "asc" },
      });

      if (!item) break;

      const locked = await transitionBulkApplyItemStatus({
        shop,
        applyRequestId,
        itemId: item.id,
        allowedFrom: ["PENDING", "FAILED"],
        to: "APPLYING",
        data: {
          error: null,
          attempt: { increment: 1 },
          startedAt: new Date(),
        },
      });

      if (locked.count !== 1) continue;

      try {
        const trustedOutput = await prisma.generatedProductOutput.findFirst({
          where: {
            shop,
            bulkApplyJobId,
            productId: item.productId,
            status: "READY",
          },
        });

        if (!trustedOutput) {
          throw new Error("TRUSTED_OUTPUT_NOT_READY");
        }

        const beforeValues = await fetchCurrentShopifyProductState({
          adminGraphql,
          productId: item.productId,
        });

        await saveBeforeSnapshotOnce({
          shop,
          bulkApplyJobId,
          productId: item.productId,
          beforeValues,
        });

        const fields = requireProductUpdateFields(trustedOutput.fields);
        const updateResult = await shopifyGraphqlWithBackoff({
          adminGraphql,
          query: PRODUCT_AND_METAFIELDS_UPDATE_MUTATION,
          variables: {
            product: {
              ...fields,
              id: item.productId,
            },
          },
        });

        throwForGraphqlErrors(updateResult);

        const userErrors = updateResult?.data?.productUpdate?.userErrors ?? [];
        if (userErrors.length > 0) {
          throw new Error(
            userErrors[0]?.message || "SHOPIFY_PRODUCT_UPDATE_FAILED"
          );
        }

        await transitionBulkApplyItemStatus({
          shop,
          applyRequestId,
          itemId: item.id,
          allowedFrom: ["APPLYING"],
          to: "APPLIED",
          data: {
            error: null,
            finishedAt: new Date(),
          },
        });
      } catch (error) {
        const nextAttempt = item.attempt + 1;

        if (nextAttempt >= MAX_ITEM_ATTEMPTS) {
          await failItemPermanently(shop, applyRequestId, item.id, error);
        } else {
          await transitionBulkApplyItemStatus({
            shop,
            applyRequestId,
            itemId: item.id,
            allowedFrom: ["APPLYING"],
            to: "FAILED",
            data: {
              error: String(
                error instanceof Error ? error.message : error
              ).slice(0, MAX_ERROR_CHARS),
              finishedAt: new Date(),
            },
          });
        }
      }

    }

    await recomputeApplyRequestStatus({ shop, applyRequestId });

    return { ok: true };
  },
  {
    // See queues/applyQueue.ts: duplicate compatible ioredis installations
    // have different nominal TypeScript identities.
    connection: redis as unknown as ConnectionOptions,
    concurrency: 4,
  }
);
