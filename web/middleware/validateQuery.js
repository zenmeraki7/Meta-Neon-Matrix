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
      return res.status(400).json({
        success: false,
        code: "VALIDATION_FAILED",
        message: "Validation failed",
        details: error.details.map((detail) => detail.message),
      });
    }

    req.body = value;
    next();
  };
};
