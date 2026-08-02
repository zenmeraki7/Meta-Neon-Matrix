import crypto from "node:crypto";

export const PAYLOAD_SCHEMA_VERSION = 1;
export const INLINE_PAYLOAD_LIMIT_BYTES = 256 * 1024;

const OPERATION_LIMITS = Object.freeze({
  OUTBOX_EVENT: 128 * 1024,
  OPERATION_ENQUEUE_INTENT: INLINE_PAYLOAD_LIMIT_BYTES,
  UNDO_COMMAND: INLINE_PAYLOAD_LIMIT_BYTES,
  UNDO_CONFLICT_CHUNK: 128 * 1024,
});

function canonicalize(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("PAYLOAD_NON_FINITE_NUMBER");
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item ?? null)).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("PAYLOAD_UNSUPPORTED_VALUE");
}

export function canonicalSerializePayload(payload) {
  return canonicalize(payload ?? null);
}

export function buildImmutablePayloadMetadata({
  payload,
  operationType,
  schemaVersion = PAYLOAD_SCHEMA_VERSION,
  storageKey = null,
  compression = null,
  enforceLimit = true,
}) {
  const canonicalPayload = canonicalSerializePayload(payload);
  const payloadByteSize = Buffer.byteLength(canonicalPayload, "utf8");
  const maximum = OPERATION_LIMITS[operationType] ?? INLINE_PAYLOAD_LIMIT_BYTES;
  if (enforceLimit && payloadByteSize > maximum && !storageKey) {
    const error = new Error("PAYLOAD_EXTERNAL_STORAGE_REQUIRED");
    error.code = "PAYLOAD_EXTERNAL_STORAGE_REQUIRED";
    error.details = { operationType, payloadByteSize, maximum };
    throw error;
  }
  return {
    payloadHash: crypto.createHash("sha256").update(canonicalPayload).digest("hex"),
    payloadByteSize,
    payloadSchemaVersion: schemaVersion,
    payloadCompression: compression,
    payloadStorageKey: storageKey,
  };
}

export function verifyImmutablePayload(payload, metadata) {
  const actual = buildImmutablePayloadMetadata({
    payload,
    operationType: metadata.operationType,
    schemaVersion: metadata.payloadSchemaVersion,
    storageKey: metadata.payloadStorageKey,
    compression: metadata.payloadCompression,
    enforceLimit: false,
  });
  if (
    actual.payloadHash !== metadata.payloadHash
    || actual.payloadByteSize !== Number(metadata.payloadByteSize)
  ) {
    const error = new Error("IMMUTABLE_PAYLOAD_INTEGRITY_FAILED");
    error.code = "IMMUTABLE_PAYLOAD_INTEGRITY_FAILED";
    throw error;
  }
  return true;
}
