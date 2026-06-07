import Joi from "joi";
import { fieldMappings } from "../utils/productExportUtils.js";

const ALLOWED_COLUMNS = Object.keys(fieldMappings);

export const productExportSchema = Joi.object({
  columns: Joi.array()
    .items(Joi.string().valid(...ALLOWED_COLUMNS))
    .min(1)
    .max(ALLOWED_COLUMNS.length)
    .required(),
  filterParams: Joi.array()
    .items(Joi.object({
      field: Joi.string().trim().max(160).required(),
      operator: Joi.string().trim().max(160).required(),
      value: Joi.any(),
    }).unknown(false))
    .max(500)
    .required(),
  filename: Joi.string()
    .pattern(/^[a-zA-Z0-9_-]+\.csv$/)
    .required(),
}).unknown(false);
