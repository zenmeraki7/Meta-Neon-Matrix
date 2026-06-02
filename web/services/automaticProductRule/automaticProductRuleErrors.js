export function publicError(code, statusCode, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;

  if (details !== undefined) {
    error.details = details;
  }

  return error;
}
