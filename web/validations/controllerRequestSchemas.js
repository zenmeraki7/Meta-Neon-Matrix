import Joi from "joi";

const MAX_TEXT_LENGTH = 500;
const MAX_LONG_TEXT_LENGTH = 5_000;
const MAX_EDIT_VALUE_JSON_LENGTH = 50_000;
const MAX_FILTER_PARAMS = 500;
const MAX_FILTER_PARAM_ARRAY_VALUES = 250;
const MAX_PRODUCT_IDS = 5_000;
const MAX_EXPORT_FIELDS = 100;

const safeIdSchema = Joi.string().trim().min(1).max(200);
const previewIdSchema = Joi.string().trim().guid({ version: ["uuidv4"] });
const previewFilterHashSchema = Joi.string().trim().hex().length(64);
const previewMirrorBatchIdSchema = Joi.string()
  .trim()
  .min(10)
  .max(200)
  .pattern(/^[A-Za-z0-9:_-]+$/);

const boundedJsonObjectSchema = Joi.object()
  .custom((value, helpers) => {
    try {
      if (JSON.stringify(value).length > MAX_EDIT_VALUE_JSON_LENGTH) {
        return helpers.error("object.max");
      }
    } catch {
      return helpers.error("object.base");
    }
    return value;
  }, "bounded JSON object");

const finiteNumberSchema = Joi.number().custom((value, helpers) => {
  if (!Number.isFinite(value)) {
    return helpers.error("number.base");
  }
  return value;
}, "finite number");

const editValueSchema = Joi.alternatives().try(
  Joi.string().max(MAX_LONG_TEXT_LENGTH),
  finiteNumberSchema,
  Joi.boolean(),
  boundedJsonObjectSchema,
).allow(null);

const filterValueSchema = Joi.alternatives().try(
  Joi.string().max(MAX_LONG_TEXT_LENGTH),
  finiteNumberSchema,
  Joi.boolean(),
  Joi.array().items(
    Joi.alternatives().try(
      Joi.string().max(MAX_LONG_TEXT_LENGTH),
      finiteNumberSchema,
      Joi.boolean(),
    ).allow(null),
  ).max(MAX_FILTER_PARAM_ARRAY_VALUES),
).allow(null);

const filterParamSchema = Joi.object({
  field: Joi.string().trim().min(1).max(160).required(),
  operator: Joi.string().trim().min(1).max(160).required(),
  value: filterValueSchema,
}).unknown(false);

function hasNonEmptyValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function hasProvidedValue(value) {
  return value !== undefined;
}

function resolveExclusiveAlias(value, helpers, primaryKey, aliasKey, {
  required = false,
  allowNull = false,
} = {}) {
  const primary = value[primaryKey];
  const alias = value[aliasKey];
  const primaryProvided = allowNull
    ? hasProvidedValue(primary)
    : hasNonEmptyValue(primary);
  const aliasProvided = allowNull
    ? hasProvidedValue(alias)
    : hasNonEmptyValue(alias);

  if (primaryProvided && aliasProvided) {
    return { error: helpers.error("object.xor", { peers: [primaryKey, aliasKey] }) };
  }
  if (required && !primaryProvided && !aliasProvided) {
    return { error: helpers.error("any.required", { label: primaryKey }) };
  }

  return { value: primaryProvided ? primary : alias };
}

function normalizeBulkEditExecuteAliases(value, helpers) {
  const editedFieldResult = resolveExclusiveAlias(value, helpers, "editedField", "field", {
    required: true,
  });
  if (editedFieldResult.error) return editedFieldResult.error;
  const editedField = editedFieldResult.value;

  const editTypeResult = resolveExclusiveAlias(value, helpers, "editType", "editedType", {
    required: true,
  });
  if (editTypeResult.error) return editTypeResult.error;
  const editType = editTypeResult.value;

  const editValueResult = resolveExclusiveAlias(value, helpers, "editValue", "value", {
    required: true,
    allowNull: true,
  });
  if (editValueResult.error) return editValueResult.error;
  const editValue = editValueResult.value;

  const {
    field: _field,
    editedType: _editedType,
    value: _value,
    ...canonical
  } = value;

  return {
    ...canonical,
    editedField,
    editType,
    editValue,
  };
}

export const bulkEditExecuteSchema = Joi.object({
  editedField: Joi.string().trim().min(1).max(160),
  field: Joi.string().trim().min(1).max(160),
  editType: Joi.string().trim().min(1).max(160),
  editedType: Joi.string().trim().min(1).max(160),
  editValue: editValueSchema,
  value: editValueSchema,
  searchKey: Joi.string().max(MAX_TEXT_LENGTH).allow("", null),
  replaceText: Joi.string().max(MAX_LONG_TEXT_LENGTH).allow("", null),
  supportValue: editValueSchema,
  locationId: safeIdSchema.allow("", null),
  location: safeIdSchema.allow("", null),
  filterParams: Joi.array().items(filterParamSchema).max(MAX_FILTER_PARAMS).default([]),
  filterAst: Joi.object().allow(null),
  previewId: previewIdSchema.required(),
  previewFilterHash: previewFilterHashSchema.required(),
  previewMirrorBatchId: previewMirrorBatchIdSchema.required(),
  previewFieldRegistryVersion: Joi.string().trim().min(1).max(120).required(),
  previewOperatorRegistryVersion: Joi.string().trim().min(1).max(120).required(),
  previewFingerprint: Joi.object({
    previewId: previewIdSchema,
    filterHash: previewFilterHashSchema.required(),
    mirrorBatchId: previewMirrorBatchIdSchema.required(),
    fieldRegistryVersion: Joi.string().trim().min(1).max(120).required(),
    operatorRegistryVersion: Joi.string().trim().min(1).max(120).required(),
  }).unknown(false).allow(null),
  confirmBroadTarget: Joi.boolean().default(false),
  criticalConfirmationText: Joi.string().max(MAX_TEXT_LENGTH).allow("", null),
  operationKey: Joi.string().trim().max(200).allow("", null),
  productIds: Joi.array().items(safeIdSchema.max(100)).max(MAX_PRODUCT_IDS).default([]),
  title: Joi.string().max(255).allow("", null),
}).unknown(false).custom(normalizeBulkEditExecuteAliases, "bulk edit execute alias normalization");

export const bulkEditPreviewSchema = Joi.object({
  field: Joi.string().trim().min(1).max(160).required(),
  editType: Joi.string().trim().min(1).max(160).required(),
  editValue: editValueSchema,
  searchKey: Joi.string().max(MAX_TEXT_LENGTH).allow("", null),
  replaceText: Joi.string().max(MAX_LONG_TEXT_LENGTH).allow("", null),
  filterParams: Joi.array().items(filterParamSchema).max(MAX_FILTER_PARAMS).default([]),
  filterAst: Joi.object().allow(null),
  supportValue: editValueSchema,
  operationKey: Joi.string().trim().max(200).allow("", null),
  cursor: Joi.string().max(MAX_TEXT_LENGTH).allow("", null),
  limit: Joi.number().integer().min(1).max(250).default(20),
}).unknown(false);

export const importRequestSchema = Joi.object({
  columnMappings: Joi.string().required(),
}).unknown(false);

export const exportRequestSchema = Joi.object({
  fields: Joi.array().items(Joi.string().trim().min(1).max(160)).min(1).max(MAX_EXPORT_FIELDS).required(),
  fileName: Joi.string().trim().min(1).required(),
  filterParams: Joi.array().items(filterParamSchema).max(MAX_FILTER_PARAMS).default([]),
  filterAst: Joi.object().allow(null),
}).unknown(false);

export const subscriptionCreateSchema = Joi.object({
  planKey: Joi.string().trim().required(),
  returnUrl: Joi.string().trim().uri().required(),
}).unknown(false);
