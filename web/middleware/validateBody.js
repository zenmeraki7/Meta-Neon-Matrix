/**
 * Validates req.body against a basic schema object.
 * @param {Record<string, { type: "string" | "number" | "boolean" | "array" | "object", required?: boolean }>} schema
 * @returns {import("express").RequestHandler}
 */
export default function validateBody(schema) {
  return function validateBodyMiddleware(req, res, next) {
    const body = req.body || {};
    const errors = [];

    for (const [field, rules] of Object.entries(schema || {})) {
      const required = Boolean(rules?.required);
      const expectedType = String(rules?.type || "").trim();
      const value = body[field];
      const exists = value !== undefined && value !== null;

      if (required && !exists) {
        errors.push({ field, error: "required" });
        continue;
      }

      if (!exists) continue;

      if (expectedType === "array") {
        if (!Array.isArray(value)) {
          errors.push({ field, error: "type", expected: "array" });
        }
        continue;
      }

      if (expectedType === "object") {
        if (typeof value !== "object" || Array.isArray(value)) {
          errors.push({ field, error: "type", expected: "object" });
        }
        continue;
      }

      if (["string", "number", "boolean"].includes(expectedType)) {
        if (typeof value !== expectedType) {
          errors.push({ field, error: "type", expected: expectedType });
        }
      }
    }

    if (errors.length > 0) {
      res.status(400).json({ error: "Validation failed", fields: errors });
      return;
    }

    next();
  };
}

