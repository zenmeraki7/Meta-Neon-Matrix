import Joi from "joi";

export const suggestionCreateSchema = Joi.object({
  email: Joi.string().trim().email().required().messages({
    "string.base": "Email must be a string",
    "string.empty": "Email is required",
    "string.email": "Email must be valid",
    "any.required": "Email is required",
  }),
  suggestion: Joi.string().trim().min(1).max(2000).required().messages({
    "string.base": "Suggestion must be a string",
    "string.empty": "Suggestion is required",
    "string.min": "Suggestion is required",
    "string.max": "Suggestion cannot exceed 2000 characters",
    "any.required": "Suggestion is required",
  }),
});

