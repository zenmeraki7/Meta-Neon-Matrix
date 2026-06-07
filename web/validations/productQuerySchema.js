import Joi from "joi";

const MAX_FILTER_VALUE_LENGTH = 500;

const numberOps = Joi.string()
  .valid("<", ">", "!=", "+", "=", "<=", ">=")
  .allow("")
  .optional();

const dateOps = Joi.string()
  .valid("is before", "is after", "is after x days ago", "is before x days ago")
  .allow("")
  .optional();

const stringOps = Joi.string()
  .valid(
    "equals",
    "does not equal",
    "contains",
    "does not contain",
    "contains any of the words",
    "starts with",
    "does not start with",
    "ends with",
    "is empty/blank",
    "equals (case insensitive)",
    "contains (case insensitive)",
  )
  .allow("")
  .optional();

const daysField = Joi.number().integer().min(1).max(3650)
  .allow("", null)
  .optional();

const stringField = (maxLen = MAX_FILTER_VALUE_LENGTH) =>
  Joi.string().max(maxLen).allow("").optional();

const productQuerySchema = Joi.object({
  created_at: stringField(),
  created_at_op: dateOps,
  created_at_days: daysField,
  published_at: stringField(),
  published_at_op: dateOps,
  published_at_days: daysField,
  updated_at: stringField(),
  updated_at_op: dateOps,
  updated_at_days: daysField,

  collection_name: stringField(),
  collection_options: Joi.string().valid("is", "is not").allow("").optional(),
  category: stringField(),
  category_option: Joi.string().valid("is", "is not").allow("").optional(),
  status: Joi.string().valid("active", "draft", "archived").allow("").optional(),

  product_type: stringField(),
  product_type_options: stringOps,
  product_id: stringField(100),
  product_id_options: Joi.string().valid("is", "is not").allow("").optional(),
  description: stringField(5000),
  description_op: stringOps,
  title: stringField(),
  title_op: stringOps,
  vendor: stringField(),
  vendor_op: stringOps,
  handle: stringField(),
  handle_op: stringOps,
  barcode: stringField(),
  barcode_op: stringOps,
  fulfillmentService: stringField(),
  fulfillmentService_op: stringOps,
  sku: stringField(),
  sku_op: stringOps,
  variant_title: stringField(),
  variant_title_op: stringOps,

  vc: Joi.number().allow("", null).optional(),
  vc_op: numberOps,
  inventory_q: Joi.number().allow("", null).optional(),
  inventory_q_op: numberOps,
  price: Joi.number().allow("", null).optional(),
  price_op: numberOps,

  search: stringField(),
  sortKey: Joi.string()
    .valid("title", "vendor", "productType", "createdAt", "updatedAt", "publishedAt", "price", "inventory")
    .allow("")
    .optional(),
  sortOrder: Joi.string().valid("asc", "desc").allow("").optional(),
  cursor: Joi.string().max(500).optional(),
  limit: Joi.number().integer().min(1).max(250).optional(),
}).unknown(false);

export default productQuerySchema;
