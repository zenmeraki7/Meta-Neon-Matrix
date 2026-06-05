import {
  findSessionScoped,
  writeColumnAppliedSessionChanges,
  writeStagedSessionChanges,
} from "../repositories/sessionChangeRepository.js";
import { toSessionChangeResultDto } from "../dtos/sessionDto.js";

const MAX_SESSION_CHANGE_BATCH_SIZE = 1000;
const MAX_METAFIELD_NAME_LENGTH = 80;
const MAX_METAFIELD_VALUE_LENGTH = 5000;
const NUMERIC_STRING = /^\d+$/;
const SAFE_CHANGE_FIELDS = new Set([
  "variantId",
  "definitionId",
  "namespace",
  "key",
  "type",
  "newValue",
  "value",
  "compareDigest",
  "shopifyOwnerId",
]);

function serviceError(message, code, fields = []) {
  const error = new Error(message);
  error.code = code;
  if (fields.length) error.fields = fields;
  return error;
}

function normalizeMetafieldIdentifier(namespace, key) {
  const resolvedNamespace = String(namespace || "").trim();
  const resolvedKey = String(key || "").trim();
  if (!resolvedNamespace || !resolvedKey) {
    throw serviceError("Validation failed", "VALIDATION_FAILED", [
      { field: "namespace/key", error: "namespace and key are required" },
    ]);
  }
  if (
    resolvedNamespace.length > MAX_METAFIELD_NAME_LENGTH
    || resolvedKey.length > MAX_METAFIELD_NAME_LENGTH
  ) {
    throw serviceError("Validation failed", "VALIDATION_FAILED", [
      { field: "namespace/key", error: "namespace and key are too long" },
    ]);
  }
  return { namespace: resolvedNamespace, key: resolvedKey };
}

function normalizeMetafieldValue(value) {
  if (value === null || value === undefined) return null;
  const resolvedValue = String(value);
  if (resolvedValue.length > MAX_METAFIELD_VALUE_LENGTH) {
    throw serviceError("Validation failed", "VALIDATION_FAILED", [
      { field: "value", error: "value too long" },
    ]);
  }
  return resolvedValue;
}

function normalizeVariantId(value, field = "variantId") {
  const resolved = String(value || "").trim();
  if (!NUMERIC_STRING.test(resolved)) {
    throw serviceError("Validation failed", "VALIDATION_FAILED", [
      { field, error: "must be a numeric string" },
    ]);
  }
  return resolved;
}

function validateChangeItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw serviceError("Validation failed", "VALIDATION_FAILED", [
      { field: "changes", error: "each change must be an object" },
    ]);
  }
  const unknownField = Object.keys(item).find((field) => !SAFE_CHANGE_FIELDS.has(field));
  if (unknownField) {
    throw serviceError("Validation failed", "VALIDATION_FAILED", [
      { field: "changes", error: `unknown field ${unknownField}` },
    ]);
  }
  for (const [field, value] of Object.entries(item)) {
    if (value !== null && typeof value === "object") {
      throw serviceError("Validation failed", "VALIDATION_FAILED", [
        { field: `changes.${field}`, error: "nested objects are not allowed" },
      ]);
    }
  }
  const { namespace, key } = normalizeMetafieldIdentifier(item.namespace, item.key);
  const newValue = normalizeMetafieldValue(
    Object.prototype.hasOwnProperty.call(item, "newValue") ? item.newValue : item.value,
  );
  return {
    ...item,
    variantId: normalizeVariantId(item.variantId),
    namespace,
    key,
    newValue,
    value: newValue,
    type: item.type == null ? "" : String(item.type).trim(),
    compareDigest: item.compareDigest == null ? null : String(item.compareDigest),
    shopifyOwnerId: item.shopifyOwnerId == null ? null : String(item.shopifyOwnerId).trim(),
    definitionId: item.definitionId == null ? null : String(item.definitionId).trim(),
  };
}

function validateSessionChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0) {
    throw serviceError("Validation failed", "VALIDATION_FAILED", [
      { field: "changes", error: "must be a non-empty array" },
    ]);
  }
  if (changes.length > MAX_SESSION_CHANGE_BATCH_SIZE) {
    throw serviceError("Validation failed", "VALIDATION_FAILED", [
      { field: "changes", error: `must contain at most ${MAX_SESSION_CHANGE_BATCH_SIZE} items` },
    ]);
  }
  return changes.map(validateChangeItem);
}

function validateColumnApplyCommand({ namespace, key, value, variantIds }) {
  const identifier = normalizeMetafieldIdentifier(namespace, key);
  const ids = Array.isArray(variantIds) ? variantIds.map((id) => normalizeVariantId(id, "variantIds")) : [];
  if (!ids.length || ids.length > MAX_SESSION_CHANGE_BATCH_SIZE) {
    throw serviceError("Validation failed", "VALIDATION_FAILED", [
      { field: "variantIds", error: `must be a non-empty array with max ${MAX_SESSION_CHANGE_BATCH_SIZE} items` },
    ]);
  }
  return {
    ...identifier,
    value: normalizeMetafieldValue(value),
    variantIds: [...new Set(ids)],
  };
}

async function assertDraftSession(sessionId, shopId) {
  const session = await findSessionScoped(sessionId, shopId);
  if (!session) {
    throw serviceError("Session not found", "SESSION_NOT_FOUND");
  }
  if (session.status === null || session.status === undefined) {
    throw serviceError("Session status is invalid", "SESSION_STATUS_INVALID");
  }
  if (String(session.status).trim().toUpperCase() !== "DRAFT") {
    throw serviceError("Session is not open", "SESSION_NOT_OPEN");
  }
}

export async function stageSessionChanges(command) {
  const { shopId, sessionId, changes } = command;
  const validatedChanges = validateSessionChanges(changes);
  await assertDraftSession(sessionId, shopId);
  const result = await writeStagedSessionChanges(sessionId, shopId, validatedChanges);
  return toSessionChangeResultDto({ staged: Number(result?.staged || 0) });
}

export async function applyColumnSessionChanges(command) {
  const { shopId, sessionId, namespace, key, value, variantIds } = command;
  const validated = validateColumnApplyCommand({ namespace, key, value, variantIds });
  await assertDraftSession(sessionId, shopId);
  const result = await writeColumnAppliedSessionChanges(
    sessionId,
    shopId,
    validated.namespace,
    validated.key,
    validated.value,
    validated.variantIds,
  );
  return toSessionChangeResultDto({ staged: Number(result?.staged || 0) });
}
