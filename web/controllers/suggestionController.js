import { SuggestionService } from "../services/SuggestionService/SuggestionService.js";
import { logApiError } from "../utils/errorLogUtils.js";
import { buildPublicApiErrorResponse } from "../utils/publicApiError.js";

const suggestionService = new SuggestionService();

export const addSuggestion = async (req, res) => {
  const session = res.locals.shopify?.session;
  const { email, suggestion } = req.body;

  if (!session?.shop) {
    const { statusCode, body } = buildPublicApiErrorResponse(
      { code: "UNAUTHENTICATED" },
      "UNAUTHENTICATED",
    );
    return res.status(statusCode).json(body);
  }

  const validationError = suggestionService.validate({ email, suggestion });
  if (validationError) {
    return res.status(400).json({ message: validationError });
  }

  try {
    await suggestionService.saveSuggestion({ email, suggestion });
    await suggestionService.sendEmailNotification({ email, suggestion });

    return res.status(201).json({ message: "Suggestion submitted successfully!" });
  } catch (error) {
    await logApiError({
      shop: session?.shop || null,
      err: error,
      req,
      source: "suggestionController.addSuggestion",
    });

    return res.status(500).json({ message: "Server error. Please try again later." });
  }
};
