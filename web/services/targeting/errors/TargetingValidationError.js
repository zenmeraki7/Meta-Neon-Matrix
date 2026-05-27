export class TargetingValidationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "TargetingValidationError";
    this.code = details.code || "TARGETING_VALIDATION_ERROR";
    this.path = details.path || null;
    this.meta = details.meta || null;
    this.statusCode = 400;
  }

  static malformedAst(message = "Malformed targeting AST", details = {}) {
    return new TargetingValidationError(message, {
      code: "MALFORMED_AST",
      ...details,
    });
  }

  static unsupportedContext(details = {}) {
    return new TargetingValidationError("Unsupported targeting context", {
      code: "UNSUPPORTED_CONTEXT",
      ...details,
    });
  }
}
