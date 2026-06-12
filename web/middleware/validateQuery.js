import { generateErrorId } from "../utils/errorUtils.js";

export const validateQuery = (schema) => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.query, {
      abortEarly: false,
      convert: true,
      allowUnknown: true,
      stripUnknown: true,
    });

    if (error) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        details: error.details.map((d) => d.message),
      });
    }

    // ✅ assign sanitized data back
    req.query = value;
    next();
  };
};

export const validateBody = (schema) => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      convert: true,
      allowUnknown: false,
      stripUnknown: true,
    });

    if (error) {
      const errorId = generateErrorId();
      const errors = Object.fromEntries(
        error.details.map((detail) => [
          detail.path.join(".") || "body",
          detail.message,
        ]),
      );
      console.warn("[request-validation:error]", {
        path: req.originalUrl || req.url,
        requestId: req.id || req.get?.("X-Request-Id") || errorId,
        errors,
        normalizedBody: value,
      });

      return res.status(400).json({
        success: false,
        code: "VALIDATION_FAILED",
        message: "Request validation failed",
        errors,
        errorId,
        details: error.details.map((detail) => detail.message),
      });
    }

    req.body = value;
    next();
  };
};
