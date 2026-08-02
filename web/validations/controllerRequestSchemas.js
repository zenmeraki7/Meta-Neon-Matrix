import Joi from "joi";

const filterParamSchema = Joi.object({
  field: Joi.string().trim().required(),
  operator: Joi.string().trim().required(),
  value: Joi.any(),
}).unknown(true);

const canonicalPriceOperations = [
  "SET_FIXED",
  "INCREASE_FIXED",
  "DECREASE_FIXED",
  "INCREASE_PERCENT",
  "DECREASE_PERCENT",
  "PERCENT_OF_COMPARE_AT_PRICE",
];

const filterAstSchema = Joi.object({
  version: Joi.string().allow("", null),
  root: Joi.object({
    nodeType: Joi.string().required(),
    logic: Joi.string().allow("", null),
    children: Joi.array().items(Joi.any()).default([]),
  }).unknown(true).required(),
}).unknown(true);

export const bulkEditExecuteSchema = Joi.object({
  editedField: Joi.string().trim().allow("", null),
  field: Joi.string().trim().allow("", null),
  operation: Joi.string().trim().allow("", null),
  editType: Joi.string().trim().allow("", null),
  editedType: Joi.string().trim().allow("", null),
  editValue: Joi.any(),
  value: Joi.any(),
  searchKey: Joi.string().allow("", null),
  replaceText: Joi.string().allow("", null),
  supportValue: Joi.any(),
  locationId: Joi.string().allow("", null),
  location: Joi.string().allow("", null),
  rounding: Joi.string().allow("", null).default("NONE"),
  rawFilterInput: Joi.array().items(filterParamSchema).default([]),
  filterAst: Joi.object().allow(null),
  filterFingerprint: Joi.string().allow("", null),
  filterVersion: Joi.string().allow("", null),
  previewId: Joi.string().required(),
  previewContractId: Joi.string().allow("", null),
  previewSignature: Joi.string().allow("", null),
  previewFilterHash: Joi.string().required(),
  previewMirrorBatchId: Joi.string().required(),
  previewFieldRegistryVersion: Joi.string().required(),
  previewOperatorRegistryVersion: Joi.string().required(),
  previewFingerprint: Joi.object({
    normalizedFilterHash: Joi.string().required(),
    mirrorBatchId: Joi.string().required(),
    fieldRegistryVersion: Joi.string().required(),
    operatorRegistryVersion: Joi.string().required(),
  }).unknown(true).allow(null),
  confirmBroadTarget: Joi.boolean().default(false),
  criticalConfirmationText: Joi.string().allow("", null),
  idempotencyKey: Joi.string().allow("", null),
  operationKey: Joi.string().allow("", null),
  productIds: Joi.array().items(Joi.string()).default([]),
  title: Joi.string().allow("", null),
}).unknown(false);

const baseBulkEditPreviewSchema = Joi.object({
  field: Joi.string().trim().required(),
  operation: Joi.string().trim().allow("", null),
  editType: Joi.string().trim().allow("", null),
  editValue: Joi.any(),
  value: Joi.any(),
  searchKey: Joi.string().allow("", null),
  replaceText: Joi.string().allow("", null),
  locationId: Joi.string().allow("", null),
  rounding: Joi.string().allow("", null),
  rawFilterInput: Joi.array().items(filterParamSchema).default([]),
  filterAst: filterAstSchema.allow(null),
  filterFingerprint: Joi.string().allow("", null),
  filterVersion: Joi.string().allow("", null),
  supportValue: Joi.any(),
  operationKey: Joi.string().allow("", null),
  cursor: Joi.string().allow("", null),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(10),
}).unknown(false);

export const bulkEditPreviewSchema = baseBulkEditPreviewSchema.when(
  Joi.object({ field: Joi.valid("price").required() }).unknown(),
  {
    then: baseBulkEditPreviewSchema.keys({
      operation: Joi.string().trim().valid(...canonicalPriceOperations).required(),
      value: Joi.alternatives()
        .try(
          Joi.string().trim().min(1),
          Joi.number().custom((value, helpers) =>
            Number.isFinite(Number(value)) ? value : helpers.error("number.base"),
          ),
        )
        .required()
        .messages({
          "any.required": "Value is required.",
          "string.empty": "Value is required.",
          "string.min": "Value is required.",
          "number.base": "Value must be a valid number.",
        }),
      locationId: Joi.string().allow("", null).default(""),
      rounding: Joi.string().allow("", null).default("NONE"),
    }),
  },
);

export const importRequestSchema = Joi.object({
  uploadToken: Joi.string().trim().min(1).required(),
  columnMappings: Joi.alternatives().try(Joi.object(), Joi.string()).required(),
  idempotencyKey: Joi.string().trim().allow("", null),
}).unknown(true);

export const exportRequestSchema = Joi.object({
  fields: Joi.array().items(Joi.string().trim()).min(1).required(),
  fileName: Joi.string().trim().min(1).required(),
  rawFilterInput: Joi.array().items(filterParamSchema).default([]),
  filterAst: Joi.object().allow(null),
  context: Joi.object().unknown(true).default({}),
  options: Joi.object({
    targetGranularity: Joi.string().trim().valid("PRODUCT", "VARIANT").default("PRODUCT"),
  }).unknown(true).default({ targetGranularity: "PRODUCT" }),
}).unknown(false);

export const subscriptionCreateSchema = Joi.object({
  planKey: Joi.string().trim().required(),
  returnUrl: Joi.string().uri().allow("", null),
}).unknown(false);
