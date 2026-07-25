import CacheService from "../../utils/cacheService.js";
import { uploadToShopifyStagedTarget } from "../../utils/productBulkEditUtils.js";
import {
  bulkOperationMutation,
  getProductSetMutation,
  PRODUCT_SET_MODE,
  stagesUploadMutation,
} from "../../helpers/productBulkOperationHelpers/mutationTemplates.js";
import { FIELD_CONFIGS } from "../../helpers/productBulkOperationHelpers/constants.js";

const OPTION_NAME_FIELDS = new Set([
  "option1Name",
  "option2Name",
  "option3Name",
  "mixed",
]);

const VARIANT_LEVEL_FIELDS = new Set([
  "price",
  "barcode",
  "sku",
  "inventory",
  "taxable",
  "compareAtPrice",
  "option1Values",
  "option2Values",
  "option3Values",
  "inventoryPolicy",
  "cost",
  "requiresShipping",
  "weight",
  "weightUnit",
]);

function isVariantLevelField(field) {
  if (FIELD_CONFIGS?.[field]?.isVariantLevel) return true;
  return VARIANT_LEVEL_FIELDS.has(field);
}

function determineMutationMode(fields = []) {
  const normalizedFields = Array.isArray(fields) ? fields.filter(Boolean) : [];
  const includesDelete = normalizedFields.includes("deleteProducts");
  const includesVariant = normalizedFields.some((field) => isVariantLevelField(field));
  const includesProduct = normalizedFields.some(
    (field) => !isVariantLevelField(field) && field !== "deleteProducts",
  );
  const includesOptionNames = normalizedFields.some((field) => OPTION_NAME_FIELDS.has(field));

  if (includesDelete) return PRODUCT_SET_MODE.PRODUCT_DELETE;
  if (includesOptionNames || (includesProduct && includesVariant)) return PRODUCT_SET_MODE.BOTH;
  if (includesVariant) return PRODUCT_SET_MODE.VARIANT_ONLY;
  return PRODUCT_SET_MODE.PRODUCT_ONLY;
}

export class ShopifyBulkMutationService {
  constructor({ client, shop }) {
    this.client = client;
    this.shop = shop;
  }

  async submitBulkMutation({ formattedProducts, field, fields = [] }) {
    const commandType = `bulkEditProducts_${Date.now()}`;
    const mode = determineMutationMode(fields.length ? fields : [field]);

    const stagedRes = await this.client.query({
      data: {
        query: stagesUploadMutation,
        variables: {
          input: [
            {
              filename: commandType,
              mimeType: "text/jsonl",
              resource: "BULK_MUTATION_VARIABLES",
              httpMethod: "POST",
            },
          ],
        },
      },
    });

    const userErrors = stagedRes?.body?.data?.stagedUploadsCreate?.userErrors;
    if (userErrors?.length) {
      throw new Error(
        `Shopify API returned errors: ${JSON.stringify(userErrors)}`,
      );
    }

    const target =
      stagedRes?.body?.data?.stagedUploadsCreate?.stagedTargets?.[0];

    if (!target) {
      throw new Error("Failed to get staged upload target from Shopify");
    }

    const keyUrl = await uploadToShopifyStagedTarget(
      target,
      formattedProducts,
    );

    const bulkRes = await this.client.query({
      data: {
        query: bulkOperationMutation,
        variables: {
          mutation: getProductSetMutation(mode),
          stagedUploadPath: keyUrl,
        },
      },
    });

    const bulkErrors =
      bulkRes?.body?.data?.bulkOperationRunMutation?.userErrors;

    if (bulkErrors?.length) {
      throw new Error(
        `Bulk operation returned errors: ${JSON.stringify(bulkErrors)}`,
      );
    }

    const result = bulkRes.body?.data?.bulkOperationRunMutation;

    await CacheService.set(`${this.shop}:PRODUCT_UPDATE`, {
      running: true,
    });

    return result;
  }
}

