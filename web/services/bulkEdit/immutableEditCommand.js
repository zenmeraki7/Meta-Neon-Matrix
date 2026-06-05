import crypto from "crypto";
import {
  assertJsonSerializable,
  hmacSha256Stable,
  sha256Stable,
} from "../../utils/canonicalJson.js";

const IMMUTABLE_EDIT_COMMAND_SCHEMA_VERSION = "1.1.0";
const LEGACY_SCHEMA_VERSION = "1.0.0";

function requireNonEmptyString(value, code) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    throw new Error(code);
  }
  return trimmed;
}

function normalizeActorUserId(actorUserId) {
  const trimmed = String(actorUserId || "").trim();
  return trimmed || null;
}

function normalizeEditIntent(edit) {
  if (!edit || typeof edit !== "object") {
    throw new Error("IMMUTABLE_EDIT_COMMAND_EDIT_REQUIRED");
  }
  assertJsonSerializable(edit, "$.edit");
  if (Array.isArray(edit) && edit.length === 0) {
    throw new Error("IMMUTABLE_EDIT_COMMAND_EDIT_REQUIRED");
  }
  if (!Array.isArray(edit) && Object.keys(edit).length === 0) {
    throw new Error("IMMUTABLE_EDIT_COMMAND_EDIT_REQUIRED");
  }
  return edit;
}

function getSigningSecret() {
  const secret = String(
    process.env.IMMUTABLE_EDIT_COMMAND_HMAC_SECRET ||
      process.env.SHOPIFY_API_SECRET ||
      process.env.ACCESS_TOKEN_ENCRYPTION_KEY ||
      "",
  );
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("IMMUTABLE_EDIT_COMMAND_SIGNING_SECRET_REQUIRED");
  }
  return "development-only-immutable-edit-command-secret";
}

function buildSignedPayload({
  commandId,
  operationType,
  shop,
  actorUserId,
  edit,
  targetSnapshotSetId,
  schemaVersion,
  createdAt,
}) {
  return {
    commandId,
    operationType,
    shop,
    actorUserId,
    edit,
    targetSnapshotSetId,
    schemaVersion,
    createdAt,
  };
}

function signPayload(payload) {
  return hmacSha256Stable(payload, getSigningSecret());
}

function timingSafeEqualHex(left, right) {
  const safeLeft = String(left || "");
  const safeRight = String(right || "");
  if (
    !/^[a-f0-9]+$/i.test(safeLeft) ||
    !/^[a-f0-9]+$/i.test(safeRight) ||
    safeLeft.length !== safeRight.length
  ) {
    return false;
  }
  const leftBuffer = Buffer.from(safeLeft, "hex");
  const rightBuffer = Buffer.from(safeRight, "hex");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function assertLegacySelfHash(command) {
  const expectedIntent = {
    operationType: String(command.operationType || ""),
    shop: String(command.shop || ""),
    actorUserId: command.actorUserId ? String(command.actorUserId) : null,
    edit: command.edit || {},
    targetSnapshotSetId: String(command.targetSnapshotSetId || ""),
  };
  const expectedHash = sha256Stable(expectedIntent);
  if (String(command.intentHash || "") !== expectedHash) {
    throw new Error("IMMUTABLE_EDIT_COMMAND_TAMPERED");
  }
}

export function buildImmutableEditCommand({
  operationType = "BULK_PRODUCT_EDIT",
  shop,
  actorUserId = null,
  edit,
  targetSnapshotSetId,
  commandId = crypto.randomUUID(),
  createdAt = new Date().toISOString(),
} = {}) {
  const payload = buildSignedPayload({
    commandId: requireNonEmptyString(commandId, "IMMUTABLE_EDIT_COMMAND_ID_REQUIRED"),
    operationType: requireNonEmptyString(
      operationType || "BULK_PRODUCT_EDIT",
      "IMMUTABLE_EDIT_COMMAND_OPERATION_TYPE_REQUIRED",
    ),
    shop: requireNonEmptyString(shop, "IMMUTABLE_EDIT_COMMAND_SHOP_REQUIRED"),
    actorUserId: normalizeActorUserId(actorUserId),
    edit: normalizeEditIntent(edit),
    targetSnapshotSetId: requireNonEmptyString(
      targetSnapshotSetId,
      "IMMUTABLE_EDIT_COMMAND_TARGET_SNAPSHOT_REQUIRED",
    ),
    schemaVersion: IMMUTABLE_EDIT_COMMAND_SCHEMA_VERSION,
    createdAt: requireNonEmptyString(createdAt, "IMMUTABLE_EDIT_COMMAND_CREATED_AT_REQUIRED"),
  });
  const intentHash = sha256Stable(payload);

  return {
    ...payload,
    idempotencyKey: `${payload.shop}:${payload.operationType}:${payload.commandId}`,
    intentHash,
    commandSignature: signPayload(payload),
    signatureAlgorithm: "HMAC-SHA256",
  };
}

export function assertImmutableEditCommandIntegrity(command) {
  if (!command || typeof command !== "object") {
    throw new Error("IMMUTABLE_EDIT_COMMAND_MISSING");
  }

  if (!command.commandSignature && String(command.schemaVersion || LEGACY_SCHEMA_VERSION) === LEGACY_SCHEMA_VERSION) {
    assertLegacySelfHash(command);
    return;
  }

  if (String(command.schemaVersion || "") !== IMMUTABLE_EDIT_COMMAND_SCHEMA_VERSION) {
    throw new Error("IMMUTABLE_EDIT_COMMAND_SCHEMA_UNSUPPORTED");
  }
  if (String(command.signatureAlgorithm || "") !== "HMAC-SHA256") {
    throw new Error("IMMUTABLE_EDIT_COMMAND_SIGNATURE_ALGORITHM_UNSUPPORTED");
  }

  const payload = buildSignedPayload({
    commandId: requireNonEmptyString(command.commandId, "IMMUTABLE_EDIT_COMMAND_ID_REQUIRED"),
    operationType: requireNonEmptyString(
      command.operationType,
      "IMMUTABLE_EDIT_COMMAND_OPERATION_TYPE_REQUIRED",
    ),
    shop: requireNonEmptyString(command.shop, "IMMUTABLE_EDIT_COMMAND_SHOP_REQUIRED"),
    actorUserId: normalizeActorUserId(command.actorUserId),
    edit: normalizeEditIntent(command.edit),
    targetSnapshotSetId: requireNonEmptyString(
      command.targetSnapshotSetId,
      "IMMUTABLE_EDIT_COMMAND_TARGET_SNAPSHOT_REQUIRED",
    ),
    schemaVersion: IMMUTABLE_EDIT_COMMAND_SCHEMA_VERSION,
    createdAt: requireNonEmptyString(
      command.createdAt,
      "IMMUTABLE_EDIT_COMMAND_CREATED_AT_REQUIRED",
    ),
  });
  const expectedHash = sha256Stable(payload);
  if (String(command.intentHash || "") !== expectedHash) {
    throw new Error("IMMUTABLE_EDIT_COMMAND_TAMPERED");
  }
  const expectedSignature = signPayload(payload);
  if (!timingSafeEqualHex(command.commandSignature, expectedSignature)) {
    throw new Error("IMMUTABLE_EDIT_COMMAND_TAMPERED");
  }
}
