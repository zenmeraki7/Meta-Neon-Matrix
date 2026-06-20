import { Worker, type ConnectionOptions } from "bullmq";
import { prisma } from "../config/database.js";
import { connection as redis } from "../config/redis.js";
import { saveBeforeSnapshotOnce } from "../lib/snapshot.server.js";
import { shopifyGraphqlWithBackoff } from "../lib/shopifyGraphqlBackoff.server.js";
import { getAdminGraphqlForShop } from "../lib/shopifyAdmin.server.js";

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

async function recoverStuckApplyItems(shop: string, bulkJobId: string) {
  const cutoff = new Date(Date.now() - STUCK_AFTER_MS);

  await prisma.bulkApplyItem.updateMany({
    where: {
      shop,
      bulkJobId,
      status: "APPLYING",
      updatedAt: { lt: cutoff },
    },
    data: {
      status: "FAILED",
      error: "Recovered stuck APPLYING item",
      finishedAt: new Date(),
    },
  });
}

async function isCancelled(shop: string, applyRequestId: string) {
  const request = await prisma.bulkApplyRequest.findFirst({
    where: { id: applyRequestId, shop },
    select: { status: true },
  });

  return request?.status === "CANCELLED";
}

async function failItemPermanently(itemId: string, error: unknown) {
  await prisma.bulkApplyItem.update({
    where: { id: itemId },
    data: {
      status: "FAILED_PERMANENT",
      error: String(error instanceof Error ? error.message : error).slice(
        0,
        MAX_ERROR_CHARS
      ),
      finishedAt: new Date(),
    },
  });
}

async function recomputeApplyRequestStatus(
  shop: string,
  bulkJobId: string,
  applyRequestId: string
) {
  const items = (await prisma.bulkApplyItem.groupBy({
    by: ["status"],
    where: { shop, bulkJobId },
    _count: { status: true },
  })) as Array<{ status: string; _count: { status: number } }>;

  const count = (status: string) =>
    items.find((x) => x.status === status)?._count.status ?? 0;

  const pending = count("PENDING");
  const applying = count("APPLYING");
  const applied = count("APPLIED");
  const failed = count("FAILED") + count("FAILED_PERMANENT");
  const cancelled = count("CANCELLED");
  const skipped = count("SKIPPED");
  const total = pending + applying + applied + failed + cancelled + skipped;

  let status = "RUNNING";

  if (cancelled > 0 && pending + applying === 0) status = "CANCELLED";
  else if (total > 0 && applied === total) status = "COMPLETED";
  else if (failed > 0 && applied > 0) status = "PARTIAL_FAILED";
  else if (failed > 0 && applied === 0 && pending + applying === 0)
    status = "FAILED";

  await prisma.bulkApplyRequest.update({
    where: { id: applyRequestId },
    data: {
      status,
      totalCount: total,
      appliedCount: applied,
      failedCount: failed,
      cancelledCount: cancelled,
      skippedCount: skipped,
      finishedAt: [
        "COMPLETED",
        "PARTIAL_FAILED",
        "FAILED",
        "CANCELLED",
      ].includes(status)
        ? new Date()
        : null,
    },
  });
}

export const applyWorker = new Worker(
  "bulk-apply",
  async (job) => {
    const { shop, bulkJobId, applyRequestId } = job.data;

    await prisma.bulkApplyRequest.update({
      where: { id: applyRequestId },
      data: {
        status: "RUNNING",
        startedAt: new Date(),
      },
    });

    await recoverStuckApplyItems(shop, bulkJobId);

    const adminGraphql = await getAdminGraphqlForShop(shop);

    while (true) {
      if (await isCancelled(shop, applyRequestId)) {
        await prisma.bulkApplyItem.updateMany({
          where: {
            shop,
            bulkJobId,
            status: { in: ["PENDING", "FAILED"] },
          },
          data: {
            status: "CANCELLED",
            finishedAt: new Date(),
          },
        });

        await recomputeApplyRequestStatus(shop, bulkJobId, applyRequestId);
        return { cancelled: true };
      }

      const item = await prisma.bulkApplyItem.findFirst({
        where: {
          shop,
          bulkJobId,
          status: { in: ["PENDING", "FAILED"] },
          attempt: { lt: MAX_ITEM_ATTEMPTS },
        },
        orderBy: { createdAt: "asc" },
      });

      if (!item) break;

      const locked = await prisma.bulkApplyItem.updateMany({
        where: {
          id: item.id,
          shop,
          status: { in: ["PENDING", "FAILED"] },
        },
        data: {
          status: "APPLYING",
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
            bulkJobId,
            productId: item.productId,
            status: "READY",
          },
        });

        if (!trustedOutput) {
          throw new Error("TRUSTED_OUTPUT_NOT_READY");
        }

        const before = await fetchCurrentShopifyProductState({
          adminGraphql,
          productId: item.productId,
        });

        await saveBeforeSnapshotOnce({
          shop,
          bulkJobId,
          productId: item.productId,
          before,
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

        await prisma.bulkApplyItem.update({
          where: { id: item.id },
          data: {
            status: "APPLIED",
            error: null,
            finishedAt: new Date(),
          },
        });
      } catch (error) {
        const nextAttempt = item.attempt + 1;

        if (nextAttempt >= MAX_ITEM_ATTEMPTS) {
          await failItemPermanently(item.id, error);
        } else {
          await prisma.bulkApplyItem.update({
            where: { id: item.id },
            data: {
              status: "FAILED",
              error: String(
                error instanceof Error ? error.message : error
              ).slice(0, MAX_ERROR_CHARS),
              finishedAt: new Date(),
            },
          });
        }
      }

      await recomputeApplyRequestStatus(shop, bulkJobId, applyRequestId);
    }

    await recomputeApplyRequestStatus(shop, bulkJobId, applyRequestId);

    return { ok: true };
  },
  {
    // See queues/applyQueue.ts: duplicate compatible ioredis installations
    // have different nominal TypeScript identities.
    connection: redis as unknown as ConnectionOptions,
    concurrency: 4,
  }
);
