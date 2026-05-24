import Joi from "joi";

const filterParamSchema = Joi.object({
  field: Joi.string().trim().required(),
  operator: Joi.string().trim().required(),
  value: Joi.any(),
}).unknown(true);

export const bulkEditExecuteSchema = Joi.object({
  editedField: Joi.string().trim().allow("", null),
  field: Joi.string().trim().allow("", null),
  editType: Joi.string().trim().allow("", null),
  editedType: Joi.string().trim().allow("", null),
  editValue: Joi.any(),
  value: Joi.any(),
  searchKey: Joi.string().allow("", null),
  replaceText: Joi.string().allow("", null),
  supportValue: Joi.any(),
  locationId: Joi.string().allow("", null),
  location: Joi.string().allow("", null),
  filterParams: Joi.array().items(filterParamSchema).default([]),
  filterAst: Joi.object().allow(null),
  previewId: Joi.string().required(),
  previewFilterHash: Joi.string().required(),
  previewMirrorBatchId: Joi.string().required(),
  previewFieldRegistryVersion: Joi.string().required(),
  previewOperatorRegistryVersion: Joi.string().required(),
  previewFingerprint: Joi.object({
    filterHash: Joi.string().required(),
    mirrorBatchId: Joi.string().required(),
    fieldRegistryVersion: Joi.string().required(),
    operatorRegistryVersion: Joi.string().required(),
  }).unknown(true).allow(null),
  confirmBroadTarget: Joi.boolean().default(false),
  criticalConfirmationText: Joi.string().allow("", null),
  operationKey: Joi.string().allow("", null),
  productIds: Joi.array().items(Joi.string()).default([]),
  title: Joi.string().allow("", null),
}).unknown(false);

export const bulkEditPreviewSchema = Joi.object({
  field: Joi.string().trim().required(),
  editType: Joi.string().trim().required(),
  editValue: Joi.any(),
  searchKey: Joi.string().allow("", null),
  replaceText: Joi.string().allow("", null),
  filterParams: Joi.array().items(filterParamSchema).default([]),
  filterAst: Joi.object().allow(null),
  supportValue: Joi.any(),
  operationKey: Joi.string().allow("", null),
  cursor: Joi.string().allow("", null),
  limit: Joi.number().integer().min(1).max(250).default(20),
}).unknown(false);

export const importRequestSchema = Joi.object({
  columnMappings: Joi.string().required(),
}).unknown(false);

export const exportRequestSchema = Joi.object({
  fields: Joi.array().items(Joi.string().trim()).min(1).required(),
  fileName: Joi.string().trim().min(1).required(),
  filterParams: Joi.array().items(filterParamSchema).default([]),
  filterAst: Joi.object().allow(null),
}).unknown(false);

export const subscriptionCreateSchema = Joi.object({
  planKey: Joi.string().trim().required(),
  returnUrl: Joi.string().uri().allow("", null),
}).unknown(false);
