import Joi from "joi";

const languageCodePattern = /^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{2,8})?$/;

const editHistoryQuerySchema = Joi.object({
  // "Favorites" is a UI filter for isFavourite=true, not an EditHistory.type value.
  type: Joi.string()
    .valid("Manual edit", "Scheduled edit", "Recurring edit", "Automatic rule", "Favorites")
    .optional(),

  search: Joi.string().max(500).optional(),

  cursor: Joi.string().max(500).optional(),
  lang: Joi.string().max(20).pattern(languageCodePattern).optional(),

  limit: Joi.number().integer().min(1).max(100).optional(),
}).unknown(false);

export default editHistoryQuerySchema;
