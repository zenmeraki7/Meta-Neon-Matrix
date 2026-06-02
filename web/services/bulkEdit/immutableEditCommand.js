import crypto from "crypto";

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function hashIntent(intent) {
  return crypto.createHash("sha256").update(stableStringify(intent)).digest("hex");
}

export function buildImmutableEditCommand({
  operationType = "BULK_PRODUCT_EDIT",
  shop,
  actorUserId = null,
  edit = {},
  targetSnapshotSetId,
} = {}) {
  const commandIntent = {
    operationType: String(operationType || "BULK_PRODUCT_EDIT"),
    shop: String(shop || ""),
    actorUserId: actorUserId ? String(actorUserId) : null,
    edit,
    targetSnapshotSetId: String(targetSnapshotSetId || ""),
  };
  const intentHash = hashIntent(commandIntent);

  return {
    ...commandIntent,
    idempotencyKey: `${commandIntent.shop}:${commandIntent.operationType}:${intentHash}`,
    intentHash,
    schemaVersion: "1.0.0",
    createdAt: new Date().toISOString(),
  };
}

export function assertImmutableEditCommandIntegrity(command) {
  if (!command || typeof command !== "object") {
    throw new Error("IMMUTABLE_EDIT_COMMAND_MISSING");
  }
  const expectedIntent = {
    operationType: String(command.operationType || ""),
    shop: String(command.shop || ""),
    actorUserId: command.actorUserId ? String(command.actorUserId) : null,
    edit: command.edit || {},
    targetSnapshotSetId: String(command.targetSnapshotSetId || ""),
  };
  const expectedHash = hashIntent(expectedIntent);
  if (String(command.intentHash || "") !== expectedHash) {
    throw new Error("IMMUTABLE_EDIT_COMMAND_TAMPERED");
  }
}
