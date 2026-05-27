import { TargetingValidationError } from "../errors/TargetingValidationError.js";

export function toTargetingErrorDto(error) {
  if (error instanceof TargetingValidationError) {
    return {
      ok: false,
      error: {
        type: "TARGETING_VALIDATION_ERROR",
        code: error.code,
        message: error.message,
        path: error.path,
        meta: error.meta,
      },
    };
  }

  return {
    ok: false,
    error: {
      type: "TARGETING_ENGINE_ERROR",
      code: "UNEXPECTED_TARGETING_ERROR",
      message: error?.message || "Unexpected targeting error",
    },
  };
}
