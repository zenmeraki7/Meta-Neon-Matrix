const MAX_SHORT_STRING_LENGTH = 255;
const MAX_STATUS_LENGTH = 100;
const MAX_COMMAND_TYPE_LENGTH = 100;

const ALLOWED_COMMAND_TYPES = Object.freeze([
  "CLEAR_PRODUCT_TYPES",
]);

function safeString(value, fallback = null, maxLength = MAX_SHORT_STRING_LENGTH) {
  if (value === undefined || value === null) return fallback;

  const stringValue = String(value).trim();

  if (!stringValue) return fallback;

  return stringValue.length > maxLength
    ? stringValue.slice(0, maxLength)
    : stringValue;
}

function safeBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  return fallback;
}

function safeDate(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeCommandType(value) {
  const commandType = safeString(
    value,
    "CLEAR_PRODUCT_TYPES",
    MAX_COMMAND_TYPE_LENGTH,
  );

  return ALLOWED_COMMAND_TYPES.includes(commandType)
    ? commandType
    : "CLEAR_PRODUCT_TYPES";
}

function resolveOperationId(result) {
  return result?.operationId || result?.id || null;
}

function resolveAcceptedAt(result) {
  return (
    result?.acceptedAt ||
    result?.queuedAt ||
    result?.createdAt ||
    result?.requestedAt ||
    null
  );
}

function resolveQueuedAt(result) {
  return (
    result?.queuedAt ||
    result?.acceptedAt ||
    result?.createdAt ||
    result?.requestedAt ||
    null
  );
}

export function toProductSyncCommandAcceptedDto(result) {
  return {
    success: true,
    data: {
      operationId: safeString(resolveOperationId(result)),
      commandType: safeCommandType(result?.commandType),
      status: safeString(
        result?.status || "QUEUED",
        "QUEUED",
        MAX_STATUS_LENGTH,
      ),
      acceptedAt: safeDate(resolveAcceptedAt(result)),
      queuedAt: safeDate(resolveQueuedAt(result)),

      /**
       * Optional. Useful when service returns an existing command due to
       * an idempotency replay.
       */
      replayed: safeBoolean(result?.replayed),
    },
  };
}

export default {
  toProductSyncCommandAcceptedDto,
};
