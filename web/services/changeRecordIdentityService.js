import crypto from "crypto";

const MAX_IDENTITY_PART_LENGTH = 512;

function requiredPart(value, name) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    const error = new Error(`CHANGE_RECORD_${name}_REQUIRED`);
    error.code = "VALIDATION_FAILED";
    throw error;
  }
  if (normalized.length > MAX_IDENTITY_PART_LENGTH) {
    const error = new Error(`CHANGE_RECORD_${name}_TOO_LONG`);
    error.code = "VALIDATION_FAILED";
    throw error;
  }
  return normalized;
}

export function normalizeChangeRecordFieldPath(fieldPath) {
  return requiredPart(fieldPath, "FIELD_PATH")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join(".");
}

export function normalizeExecutionAttempt(value = 1) {
  const attempt = Number(value ?? 1);
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    const error = new Error("CHANGE_RECORD_EXECUTION_ATTEMPT_INVALID");
    error.code = "VALIDATION_FAILED";
    throw error;
  }
  return attempt;
}

export function buildChangeRecordIdentity({
  shop,
  editHistoryId,
  targetIdentity,
  fieldPath,
  executionAttempt = 1,
}) {
  const canonical = [
    requiredPart(shop, "SHOP"),
    requiredPart(editHistoryId, "EDIT_HISTORY_ID"),
    requiredPart(targetIdentity, "TARGET_IDENTITY"),
    normalizeChangeRecordFieldPath(fieldPath),
    String(normalizeExecutionAttempt(executionAttempt)),
  ];

  return crypto
    .createHash("sha256")
    .update(canonical.join("\u001f"))
    .digest("hex");
}

export function withAuthoritativeChangeIdentity(record) {
  const fieldPath = normalizeChangeRecordFieldPath(record?.fieldPath);
  const executionAttempt = normalizeExecutionAttempt(record?.executionAttempt);
  const normalized = {
    ...record,
    shop: requiredPart(record?.shop, "SHOP"),
    editHistoryId: requiredPart(record?.editHistoryId, "EDIT_HISTORY_ID"),
    targetIdentity: requiredPart(record?.targetIdentity, "TARGET_IDENTITY"),
    fieldPath,
    executionAttempt,
  };
  return {
    ...normalized,
    changeIdentity: buildChangeRecordIdentity(normalized),
  };
}

export async function upsertAuthoritativeChangeRecord({ tx, data }) {
  const row = withAuthoritativeChangeIdentity(data);
  return tx.changeRecord.upsert({
    where: {
      shop_changeIdentity: {
        shop: row.shop,
        changeIdentity: row.changeIdentity,
      },
    },
    create: row,
    update: {
      status: row.status,
      failureCode: row.failureCode ?? null,
      failureMessage: row.failureMessage ?? null,
      options: row.options,
      updatedAt: new Date(),
    },
  });
}

export async function upsertAuthoritativeChangeRecords({ tx, records }) {
  const results = [];
  for (const data of records || []) {
    // Sequential writes preserve deterministic input order and make each
    // field-level conflict decision explicit.
    // eslint-disable-next-line no-await-in-loop
    results.push(await upsertAuthoritativeChangeRecord({ tx, data }));
  }
  return results;
}
