import crypto from "crypto";

export const UNDO_VALUE_SERIALIZER_VERSION = "undo-canonical-json-v1";

function normalize(value) {
  if (value === undefined) return { kind: "absent" };
  if (value === null) return { kind: "null" };
  if (Array.isArray(value)) return value.map(normalize);
  if (value instanceof Date) return { kind: "date", value: value.toISOString() };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { kind: "number", value: String(value) };
    return { kind: "number", value: Object.is(value, -0) ? "0" : String(value) };
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize(value[key])])
    );
  }
  return { kind: typeof value, value };
}

export function canonicalizeUndoValue(fieldPath, value) {
  const field = String(fieldPath || "").split(".").pop();
  if (field === "tags" && Array.isArray(value)) {
    return normalize([...value].map(String).sort());
  }
  if (["price", "compareAtPrice"].includes(field)) {
    const number = Number(value);
    if (Number.isFinite(number)) {
      return { kind: "decimal", value: number.toFixed(6).replace(/0+$/, "").replace(/\.$/, "") };
    }
  }
  return normalize(value);
}

export function hashUndoValue(fieldPath, value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalizeUndoValue(fieldPath, value)))
    .digest("hex");
}

export function wrapUndoValue(value) {
  return value === undefined ? { kind: "absent" } : { kind: "value", value };
}

export function unwrapUndoValue(envelope) {
  if (!envelope || envelope.kind === "absent") return undefined;
  return envelope.value;
}

export function buildImmutableUndoItems(records = []) {
  const items = [];
  for (const record of records) {
    for (const change of Array.isArray(record?.productFieldChanges) ? record.productFieldChanges : []) {
      if (!change?.field || !Object.hasOwn(change, "newValue")) continue;
      const beforeValue = Object.hasOwn(change, "revertValue")
        ? change.revertValue
        : change.oldValue;
      if (beforeValue === undefined) continue;
      const fieldPath = `product.${change.field}`;
      items.push({
        targetIdentity: String(record.targetIdentity),
        targetResourceType: "PRODUCT",
        targetId: String(record.productId),
        productId: String(record.productId),
        variantId: null,
        targetContext: {
          productOptions: Array.isArray(record.options) ? record.options : [],
        },
        fieldPath,
        beforeValue: wrapUndoValue(beforeValue),
        beforeValueHash: hashUndoValue(fieldPath, beforeValue),
        writtenValueHash: hashUndoValue(fieldPath, change.newValue),
        serializerVersion: UNDO_VALUE_SERIALIZER_VERSION,
        outcome: "APPROVED",
      });
    }
    for (const variant of Array.isArray(record?.variantFieldChanges) ? record.variantFieldChanges : []) {
      const changes = Array.isArray(variant?.changes) ? variant.changes : [variant];
      for (const change of changes) {
        if (!change?.field || !variant?.variantId || !Object.hasOwn(change, "newValue")) continue;
        const beforeValue = Object.hasOwn(change, "revertValue")
          ? change.revertValue
          : change.oldValue;
        if (beforeValue === undefined) continue;
        const fieldPath = `variant:${variant.variantId}.${change.field}`;
        items.push({
          targetIdentity: String(record.targetIdentity),
          targetResourceType: "VARIANT",
          targetId: String(variant.variantId),
          productId: String(record.productId),
          variantId: String(variant.variantId),
          targetContext: {
            productOptions: Array.isArray(record.options) ? record.options : [],
            selectedOptions: Array.isArray(variant.selectedOptions)
              ? variant.selectedOptions
              : [],
          },
          fieldPath,
          beforeValue: wrapUndoValue(beforeValue),
          beforeValueHash: hashUndoValue(fieldPath, beforeValue),
          writtenValueHash: hashUndoValue(fieldPath, change.newValue),
          serializerVersion: UNDO_VALUE_SERIALIZER_VERSION,
          outcome: "APPROVED",
        });
      }
    }
  }
  const unique = new Map();
  for (const item of items) {
    const key = `${item.targetIdentity}|${item.fieldPath}`;
    const previous = unique.get(key);
    if (
      previous &&
      (previous.beforeValueHash !== item.beforeValueHash ||
        previous.writtenValueHash !== item.writtenValueHash ||
        previous.targetId !== item.targetId ||
        JSON.stringify(previous.targetContext) !== JSON.stringify(item.targetContext))
    ) {
      const error = new Error("UNDO_FIELD_EVIDENCE_AMBIGUOUS");
      error.code = "UNDO_FIELD_EVIDENCE_AMBIGUOUS";
      error.details = { targetIdentity: item.targetIdentity, fieldPath: item.fieldPath };
      throw error;
    }
    unique.set(key, item);
  }
  return [...unique.values()].sort((left, right) =>
    `${left.targetIdentity}|${left.fieldPath}`.localeCompare(
      `${right.targetIdentity}|${right.fieldPath}`
    )
  );
}
