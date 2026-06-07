import Joi from "joi";
import {
  COLLECTION_OPERATIONS,
  FIELD_CONFIGS,
  NUMERIC_OPERATIONS,
  TAG_OPERATIONS,
  TEXT_OPERATIONS,
} from "../helpers/productBulkOperationHelpers/constants.js";

const MAX_TITLE_LENGTH = 255;
const MAX_FILTER_PARAMS = 500;
const MAX_FILTER_FIELD_LENGTH = 160;
const MAX_FILTER_OPERATOR_LENGTH = 160;
const MAX_STEPS = 50;
const MAX_EDIT_VALUE_JSON_LENGTH = 50_000;
const MAX_EDIT_VALUE_DEPTH = 8;
const MAX_EDIT_VALUE_NODES = 500;
const MAX_TIMEZONE_LENGTH = 100;

const ALLOWED_EDIT_FIELDS = Object.freeze(Object.keys(FIELD_CONFIGS || {}));

const ALLOWED_EDIT_TYPES = Object.freeze([
  ...new Set([
    ...Object.keys(TEXT_OPERATIONS || {}),
    ...Object.keys(NUMERIC_OPERATIONS || {}),
    ...Object.keys(TAG_OPERATIONS || {}),
    ...Object.keys(COLLECTION_OPERATIONS || {}),
    "DELETE_PRODUCTS",
    "Set status",
    "Set taxable",
    "SET_INVENTORY_POLICY",
    "Set value",
  ]),
]);

function countJsonNodes(value, depth = 0) {
  if (depth > MAX_EDIT_VALUE_DEPTH) {
    return MAX_EDIT_VALUE_NODES + 1;
  }

  if (!value || typeof value !== "object") {
    return 1;
  }

  if (Array.isArray(value)) {
    return 1 + value.reduce((count, item) => count + countJsonNodes(item, depth + 1), 0);
  }

  return 1 + Object.values(value).reduce(
    (count, item) => count + countJsonNodes(item, depth + 1),
    0,
  );
}

const boundedEditValue = Joi.any().custom((value, helpers) => {
  try {
    if (JSON.stringify(value).length > MAX_EDIT_VALUE_JSON_LENGTH) {
      return helpers.error("any.invalid");
    }
  } catch {
    return helpers.error("any.invalid");
  }

  if (countJsonNodes(value) > MAX_EDIT_VALUE_NODES) {
    return helpers.error("any.invalid");
  }

  return value;
}, "bounded recurring edit value");

const filterParamSchema = Joi.object({
  field: Joi.string().trim().min(1).max(MAX_FILTER_FIELD_LENGTH).required(),
  operator: Joi.string().trim().min(1).max(MAX_FILTER_OPERATOR_LENGTH).required(),
  value: Joi.any(),
}).unknown(false);

const timezoneSchema = Joi.string()
  .trim()
  .max(MAX_TIMEZONE_LENGTH)
  .pattern(/^[A-Za-z_]+(?:\/[A-Za-z_]+)*$/)
  .custom((value, helpers) => {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: value });
      return value;
    } catch {
      return helpers.error("string.pattern.base");
    }
  }, "valid IANA timezone")
  .default("UTC");

export const recurringEditSchema = Joi.object({
  title: Joi.string().trim().max(MAX_TITLE_LENGTH).required(),

  frequency: Joi.string()
    .valid("Daily", "Weekly", "Monthly", "Hourly", "Every 2 Hours")
    .required(),

  timeToRun: Joi.when("frequency", {
    is: Joi.valid("Daily", "Weekly", "Monthly"),
    then: Joi.string()
      .pattern(/^([01]\d|2[0-3]):([0-5]\d)$/)
      .required(),
    otherwise: Joi.forbidden(),
  }),

  dayOfMonthToRun: Joi.when("frequency", {
    is: "Monthly",
    // Day 29-31 can skip some months; cap at 28 so monthly schedules run every month.
    then: Joi.number().integer().min(1).max(28).required(),
    otherwise: Joi.forbidden(),
  }),

  daysOfWeekToRun: Joi.when("frequency", {
    is: "Weekly",
    then: Joi.array()
      .items(
        Joi.string().valid(
          "Sunday",
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday"
        )
      )
      .min(1)
      .required(),
    otherwise: Joi.forbidden(),
  }),

  timezone: timezoneSchema,

  filterParams: Joi.alternatives()
    .try(
      Joi.array().items(filterParamSchema).min(1).max(MAX_FILTER_PARAMS),
      Joi.object().min(1).unknown(true),
    )
    .required(),

  steps: Joi.array()
    .items(
      Joi.object({
        field: Joi.string()
          .trim()
          .max(100)
          .pattern(/^[a-zA-Z][a-zA-Z0-9_.]*$/)
          .valid(...ALLOWED_EDIT_FIELDS)
          .required(),
        value: boundedEditValue.required(),
        editType: Joi.string().trim().valid(...ALLOWED_EDIT_TYPES).required(),
      }).unknown(false)
    )
    .min(1)
    .max(MAX_STEPS)
    .required(),

  status: Joi.string().valid("Active", "Inactive").default("Active"),
}).unknown(false);
