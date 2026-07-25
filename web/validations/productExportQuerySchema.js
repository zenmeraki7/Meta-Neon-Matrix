import Joi from "joi";
import { fieldMappings } from "../utils/productExportUtils.js";

export const productExportSchema = Joi.object({
  columns: Joi.array()
    .items(Joi.string().valid(...Object.keys(fieldMappings)))
    .required(),
  rawFilterInput: Joi.array().required(),
  filename: Joi.string()
    .pattern(/^[a-zA-Z0-9_-]+\.csv$/)
    .required(),
});
