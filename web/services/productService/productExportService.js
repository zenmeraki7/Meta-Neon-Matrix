import shopify from "../../shopify.js";
import { Parser } from "json2csv";
import { fieldMappings } from "../../utils/productExportUtils.js";
import { graphqlProductsExportQuery  } from "../../graphql/product.js";
import CacheService from "../../utils/cacheService.js";
import { EXPORT_TYPES } from "../../config/constants.js";
import { getCache, setCache } from "../../utils/cacheUtils.js";
import { prisma } from "../../config/database.js";
import { TargetingEngineService } from "../targeting/TargetingEngineService.js";
import {
  EXPORT_EXECUTION_STATES,
} from "../exportExecutionStateService.js";
import { OPERATION_LIFECYCLE_STATES } from "../operationLifecycleStateMachine.js";
import {
  normalizeExportJobExecutionState,
  normalizeExportJobStatus,
} from "../../utils/normalizedStateUtils.js";
import { addbulkExportJob } from "../../Jobs/Queues/bulkExportJob.js";
import { clearKeyCaches } from "../../utils/cacheUtils.js";
import {
  acquireExclusiveShopWork,
  releaseExclusiveShopWork,
  LOCK_NS,
} from "../shopWorkLeaseService.js";

export class ProductExportService {
  constructor(session) {
    this.session = session;
    this.client = new shopify.api.clients.Graphql({ session });
    this.fieldMappings = fieldMappings;
  }

  async _countProducts({ queryFilter = null }) {
    try {
      const countData = await this.client.query({
        data: {
          query: `
            query GetProductsCount($query: String) {
              productsCount(query: $query, limit: null) {
                count
              }
            }
          `,
          variables: { query: queryFilter },
        },
      });
      const count = countData.body.data.productsCount.count;

      return count;
    } catch (err) {
      throw new Error(err.message);
    }
  }

  async fetchProducts({ queryFilter = null, count = 0 }) {
  const cacheKey = `${this.session.shop}:${queryFilter}:export`;
  const cacheData = await CacheService.get(cacheKey);

  if (cacheData) {
    return cacheData;
  }

  let hasNextPage = true;
  let endCursor = null;
  const allProducts = [];

  while (hasNextPage) {
    const response = await this.client.query({
      data: {
        query: graphqlProductsExportQuery,
        variables: {
          first: 250,
          after: endCursor,
          query: queryFilter || null,
        },
      },
    });

    const connection = response.body?.data?.products;
    const edges = connection?.edges || [];
    const pageInfo = connection?.pageInfo;

    const nodes = edges.map((edge) => ({
      ...edge.node,
      variants: Array.isArray(edge.node?.variants?.edges)
        ? edge.node.variants.edges.map((variantEdge) => variantEdge.node)
        : [],
    }));

    allProducts.push(...nodes);

    hasNextPage = Boolean(pageInfo?.hasNextPage);
    endCursor = pageInfo?.endCursor || null;

    if (count > 0 && allProducts.length >= count) {
      break;
    }
  }

  await setCache(cacheKey, allProducts, 300);
  return allProducts;
}

  _checkValidation(count, activePlan) {
    if (activePlan === "Basic (Monthly)") {
      if (count > 50) {
        throw new Error(
          "You are a basic plan user, you can only export 50 products at a time"
        );
      }
    } else if (activePlan === "Advanced (Monthly)") {
      if (count > 150) {
        throw new Error(
          "You are a pro plan user, you can only export 100 products at a time"
        );
      }
    }
  }

transformToCSV(products, requestedColumns) {
  const csvData = [];

  const getNestedValue = (obj, path, defaultValue = "") =>
  path.reduce((acc, key) => {
    if (acc === null || acc === undefined) return defaultValue;

    const resolvedKey =
      Array.isArray(acc) && !Number.isNaN(Number(key)) ? Number(key) : key;

    return acc[resolvedKey] !== undefined && acc[resolvedKey] !== null
      ? acc[resolvedKey]
      : defaultValue;
  }, obj);

  const safeSplitPop = (val) => (val ? val.toString().split("/").pop() : "");

  products.forEach((product) => {
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const featuredImage = product?.featuredMedia?.preview?.image || null;

    if (variants.length > 0) {
      variants.forEach((variant, index) => {
        const row = {};

        requestedColumns.forEach((column) => {
          const path = this.fieldMappings[column]?.split(".") || [];
          let value = "";

          if (path[0] === "variants") {
            value = getNestedValue(variant, path.slice(1));
          } else if (path[0] === "images" && featuredImage) {
            value = getNestedValue(featuredImage, path.slice(1));
          } else {
            value = index === 0 ? getNestedValue(product, path) : "";
          }

          if (column === "Weight") {
            const weight = variant?.inventoryItem?.measurement?.weight;
            value = weight ? `${weight.value} ${weight.unit}` : "Not Specified";
          }

          if (column === "ProductID") {
            value = index === 0 ? safeSplitPop(product.id) : "";
          }

          if (column === "VariantID") {
            value = safeSplitPop(value);
          }

          row[column] =
            value !== null && value !== undefined ? value.toString() : "";
        });

        csvData.push(row);
      });
    } else {
      const row = {};

      requestedColumns.forEach((column) => {
        const path = this.fieldMappings[column]?.split(".") || [];
        let value =
          path[0] === "images" && featuredImage
            ? getNestedValue(featuredImage, path.slice(1))
            : getNestedValue(product, path);

        if (column === "VariantID") value = safeSplitPop(value);
        if (column === "ProductID") value = safeSplitPop(product.id);

        row[column] =
          value !== null && value !== undefined ? value.toString() : "";
      });

      csvData.push(row);
    }
  });

  const parser = new Parser();
  return parser.parse(csvData);
}
  async getAllExportHistories(lang) {
    const cacheKey = `${this.session.shop}:fetchExportHistories:${lang}`;

    const cacheHistories = await getCache(cacheKey);
    if (cacheHistories) return cacheHistories;

    // ✅ CONVERTED TO PRISMA
    const histories = await prisma.exportJob.findMany({
      where: { shop: this.session.shop },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    const formatedHistory = histories.map((history) => ({
      ...history,
      rawType: history.type || "",
      type: EXPORT_TYPES[history.type]?.[lang] || history.type || "",
    }));

    await setCache(cacheKey, formatedHistory, 300);
    return formatedHistory;
  }

  async getExportHistoryDetails(id) {
  if (!id || id === "undefined" || id === "null") {
    throw new Error("Invalid export history ID");
  }

  const history = await prisma.exportJob.findFirst({
    where: {
      id,
      shop: this.session.shop,
    },
  });

  if (!history) {
    throw new Error("export history not found");
  }

  return history;
}

  async createExportJob({
    fields,
    fileName,
    filterParams,
    filterAst = null,
    actor = null,
    entitlementSnapshot = null,
  }) {
    const filename = fileName?.endsWith(".csv") ? fileName : `${fileName}.csv`;
    const shop = this.session.shop;
    let writeCatalogLock = null;

    const active = await prisma.exportJob.findFirst({
      where: {
        shop,
        statusNormalized: normalizeExportJobStatus("PROCESSING"),
        executionStateNormalized: {
          in: [
            normalizeExportJobExecutionState("RUNNING"),
            normalizeExportJobExecutionState("FINALIZING"),
          ],
        },
      },
    });
    if (active) {
      throw new Error("Another export is already running for this shop");
    }

    writeCatalogLock = await acquireExclusiveShopWork({
      shop,
      namespace: LOCK_NS.WRITE_CATALOG,
      activity: "manual_export_prepare",
      worker: "ProductExportService.createExportJob",
      queue: "api",
    });
    if (!writeCatalogLock.acquired) {
      throw new Error("Another catalog write operation is already running. Please retry shortly.");
    }
    try {
      const { jobId } = await prisma.$transaction(async (tx) => {
        const job = await tx.exportJob.create({
          data: {
            shop,
            filename,
            fields,
            filterQuery: "{}",
            status: "PENDING",
            statusNormalized: normalizeExportJobStatus("PENDING"),
            executionState: OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
            executionStateNormalized: normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.PLANNED),
            entitlementSnapshot,
            actorType: actor?.actorType || null,
            actorId: actor?.actorId || null,
            actorEmail: actor?.actorEmail || null,
            actorName: actor?.actorName || null,
          },
        });

        const resolvedTarget = await TargetingEngineService.resolveAndFreezeExportTargets({
          shop,
          source: "EXPORT",
          targetType: "PRODUCT",
          targetGranularity: "PRODUCT",
          filterAst,
          legacyFilterParams: Array.isArray(filterParams) ? filterParams : [],
          ownerType: "EXPORT_JOB",
          ownerId: job.id,
          mutationIntent: {
            operationType: "EXPORT",
            mutationType: "CSV_EXPORT",
            mutationPayload: {
              fields,
              filename,
            },
            targetGranularity: "PRODUCT",
          },
          queryParams: { cursor: null, limit: 20 },
          sampleLimit: 20,
          db: tx,
        });
        const frozenCount = Number(resolvedTarget.frozenCount || 0);

        await tx.exportJob.update({
          where: { id: job.id },
          data: {
            targetSnapshotCount: frozenCount,
            executionState: OPERATION_LIFECYCLE_STATES.TARGET_FROZEN,
            executionStateNormalized: normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.PLANNED),
          },
        });

        return { jobId: job.id };
      });

      await clearKeyCaches(`${shop}:fetchExportHistories:`);
      await addbulkExportJob({
        exportJobId: jobId,
        shop,
        fields,
        source: "manual_export",
        executionId: jobId,
      });
      await prisma.exportJob.update({
        where: { id: jobId },
        data: {
          executionState: OPERATION_LIFECYCLE_STATES.QUEUED,
          executionStateNormalized: normalizeExportJobExecutionState(EXPORT_EXECUTION_STATES.QUEUED),
        },
      });

      return prisma.exportJob.findUnique({ where: { id: jobId } });
    } finally {
      await releaseExclusiveShopWork(writeCatalogLock?.lockKey);
    }
  }
}
