import crypto from "node:crypto";
import { FIELD_CONFIGS } from "./productBulkOperationHelpers/constants.js";

const TARGET_TYPES = new Set([
  "PRODUCT",
  "VARIANT",
  "INVENTORY_ITEM",
  "METAFIELD",
  "PRODUCT_OPTION",
  "COLLECTION_MEMBERSHIP",
  "INVENTORY_LEVEL",
]);

const aliases = new Map();
for (const [key, config] of Object.entries(FIELD_CONFIGS)) {
  for (const value of [key, config?.fieldName, config?.displayName]) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized) aliases.set(normalized, key);
  }
}

function fail(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  throw error;
}

function stable(value) {
  if (value === undefined) return '"__undefined__"';
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function hash(value) {
  return crypto.createHash("sha256").update(stable(value)).digest("hex");
}

function text(value) {
  const result = String(value || "").trim();
  return result || null;
}

function canonicalFieldName(rawField) {
  const raw = text(rawField);
  if (!raw) return null;
  return aliases.get(raw.toLowerCase()) || raw.replace(/\s+/g, "_").toLowerCase();
}

function changesFromMutation(plannedMutation = {}) {
  const changes = [];
  for (const change of Array.isArray(plannedMutation.productFieldChanges)
    ? plannedMutation.productFieldChanges
    : []) {
    if (change?.field) changes.push({ scope: "PRODUCT", ...change });
  }
  for (const variant of Array.isArray(plannedMutation.variantFieldChanges)
    ? plannedMutation.variantFieldChanges
    : []) {
    const variantChanges = Array.isArray(variant?.changes) ? variant.changes : [variant];
    for (const change of variantChanges) {
      if (change?.field) changes.push({ scope: "VARIANT", ...change });
    }
  }
  const metafield = plannedMutation.metafield || plannedMutation.metafieldsSetInput;
  if (metafield && typeof metafield === "object") {
    changes.push({ scope: "METAFIELD", field: "value", oldValue: metafield.oldValue, newValue: metafield.value });
  }
  return changes;
}

function assertFieldFamily(targetResourceType, canonicalField) {
  const config = FIELD_CONFIGS[canonicalField];
  if (targetResourceType === "PRODUCT_OPTION") {
    if (!/^option[123](name|values)$/i.test(canonicalField)) fail("TARGET_FIELD_FAMILY_UNSUPPORTED", { targetResourceType, canonicalField });
    return;
  }
  if (targetResourceType === "COLLECTION_MEMBERSHIP") {
    if (canonicalField !== "collections") fail("TARGET_FIELD_FAMILY_UNSUPPORTED", { targetResourceType, canonicalField });
    return;
  }
  if (targetResourceType === "INVENTORY_LEVEL") {
    if (!["inventory", "inventoryQuantity", "available"].includes(canonicalField)) fail("TARGET_FIELD_FAMILY_UNSUPPORTED", { targetResourceType, canonicalField });
    return;
  }
  if (targetResourceType === "METAFIELD" || targetResourceType === "INVENTORY_ITEM") return;
  if (!config) fail("TARGET_FIELD_UNSUPPORTED", { targetResourceType, canonicalField });
  if (targetResourceType === "PRODUCT" && config.isVariantLevel) fail("TARGET_FIELD_FAMILY_UNSUPPORTED", { targetResourceType, canonicalField });
  if (targetResourceType === "VARIANT" && !config.isVariantLevel) fail("TARGET_FIELD_FAMILY_UNSUPPORTED", { targetResourceType, canonicalField });
}

export function normalizeTargetSnapshotRow(row = {}) {
  let targetResourceType = String(row.targetResourceType || "").trim().toUpperCase();
  if (!TARGET_TYPES.has(targetResourceType)) fail("TARGET_RESOURCE_TYPE_UNSUPPORTED", { targetResourceType });

  const productId = text(row.productId);
  const variantId = text(row.variantId);
  const inventoryItemId = text(row.inventoryItemId);
  const locationId = text(row.locationId);
  const collectionId = text(row.collectionId);
  let optionPosition = Number.isInteger(Number(row.productOptionPosition || row.optionPosition))
    ? Number(row.productOptionPosition || row.optionPosition)
    : null;
  const plannedMutation = row.plannedMutation && typeof row.plannedMutation === "object"
    ? row.plannedMutation
    : {};
  const changes = changesFromMutation(plannedMutation);
  const isAtomicMutationGroup = row.atomicMutationGroup === true;

  if (changes.length > 1 && !isAtomicMutationGroup) {
    fail("TARGET_MULTI_FIELD_ROW_REQUIRES_ATOMIC_GROUP", { fields: changes.map((change) => change.field) });
  }
  const change = changes[0] || null;
  const suppliedFieldPath = text(row.fieldPath);
  const suppliedAtomicFieldPath = suppliedFieldPath?.startsWith("atomic.")
    ? suppliedFieldPath
    : null;
  if (suppliedAtomicFieldPath && !isAtomicMutationGroup) {
    fail("TARGET_ATOMIC_FIELD_PATH_REQUIRES_ATOMIC_GROUP");
  }
  const familyPrefix = `${targetResourceType.toLowerCase()}.`;
  let canonicalField = canonicalFieldName(
    suppliedAtomicFieldPath
      ? change?.field
      : suppliedFieldPath?.startsWith(familyPrefix)
      ? suppliedFieldPath.slice(familyPrefix.length)
      : suppliedFieldPath || change?.field || (row.targetResolutionOnly === true ? "selection" : null)
  );
  if (!canonicalField) fail("TARGET_FIELD_PATH_REQUIRED");

  const optionMatch = canonicalField.match(/^option([123])(name|values)$/i);
  if (optionMatch) {
    targetResourceType = "PRODUCT_OPTION";
    optionPosition ||= Number(optionMatch[1]);
  }
  if (canonicalField === "collections") {
    if (!collectionId) fail("COLLECTION_MEMBERSHIP_IDENTITY_REQUIRED");
    targetResourceType = "COLLECTION_MEMBERSHIP";
  }
  if (["inventory", "inventoryQuantity", "available"].includes(canonicalField)) {
    if (!inventoryItemId || !locationId) fail("INVENTORY_LEVEL_IDENTITY_REQUIRED");
    targetResourceType = "INVENTORY_LEVEL";
  }

  const metafield = plannedMutation.metafield || plannedMutation.metafieldsSetInput || {};
  const isMetafield = targetResourceType === "METAFIELD";
  const metafieldOwnerId = text(
    row.metafieldOwnerId ||
      (isMetafield ? metafield.ownerId || variantId || productId : null)
  );
  const metafieldOwnerType = text(
    row.metafieldOwnerType || metafield.ownerType
  )?.toUpperCase() || null;
  const metafieldNamespace = text(row.metafieldNamespace || metafield.namespace);
  const metafieldKey = text(row.metafieldKey || metafield.key);
  if (targetResourceType === "METAFIELD") canonicalField = "metafield.value";

  if (canonicalField !== "selection") {
    assertFieldFamily(targetResourceType, canonicalField);
  }

  let targetKey;
  if (targetResourceType === "PRODUCT" && productId && !variantId && !inventoryItemId && !locationId && !collectionId && !optionPosition && !metafieldOwnerId) targetKey = `PRODUCT:${productId}`;
  else if (targetResourceType === "VARIANT" && productId && variantId && !inventoryItemId && !locationId && !collectionId && !optionPosition && !metafieldOwnerId) targetKey = `VARIANT:${productId}:${variantId}`;
  else if (targetResourceType === "INVENTORY_ITEM" && productId && variantId && inventoryItemId && !locationId && !collectionId && !optionPosition && !metafieldOwnerId) targetKey = `INVENTORY_ITEM:${productId}:${variantId}:${inventoryItemId}`;
  else if (targetResourceType === "INVENTORY_LEVEL" && productId && variantId && inventoryItemId && locationId && !collectionId && !optionPosition && !metafieldOwnerId) targetKey = `INVENTORY_LEVEL:${inventoryItemId}:${locationId}`;
  else if (targetResourceType === "PRODUCT_OPTION" && productId && optionPosition >= 1 && optionPosition <= 3 && !variantId && !inventoryItemId && !locationId && !collectionId && !metafieldOwnerId) targetKey = `PRODUCT_OPTION:${productId}:${optionPosition}`;
  else if (targetResourceType === "COLLECTION_MEMBERSHIP" && productId && collectionId && !variantId && !inventoryItemId && !locationId && !optionPosition && !metafieldOwnerId) targetKey = `COLLECTION_MEMBERSHIP:${productId}:${collectionId}`;
  else if (targetResourceType === "METAFIELD" && metafieldOwnerId && metafieldOwnerType && metafieldNamespace && metafieldKey && !inventoryItemId && !locationId && !collectionId && !optionPosition) targetKey = `METAFIELD:${metafieldOwnerType}:${metafieldOwnerId}:${metafieldNamespace}:${metafieldKey}`;
  else fail("TARGET_IDENTITY_COMBINATION_INVALID", { targetResourceType });

  const fieldPath = suppliedAtomicFieldPath
    ? suppliedAtomicFieldPath
    : changes.length > 1
    ? `atomic.${targetResourceType.toLowerCase()}.${hash(changes.map((item) => canonicalFieldName(item.field))).slice(0, 24)}`
    : targetResourceType === "METAFIELD"
      ? `metafield.${metafieldNamespace}.${metafieldKey}`
      : `${targetResourceType.toLowerCase()}.${canonicalField}`;

  return {
    targetResourceType,
    targetKey,
    fieldPath,
    productId: targetResourceType === "METAFIELD" ? null : productId,
    variantId: targetResourceType === "METAFIELD" ? null : variantId,
    inventoryItemId,
    locationId,
    collectionId,
    productOptionPosition: optionPosition,
    metafieldOwnerId,
    metafieldOwnerType,
    metafieldNamespace,
    metafieldKey,
    beforeValueHash:
      text(row.beforeValueHash) ||
      hash(change && Object.hasOwn(change, "oldValue") ? change.oldValue : row.beforeValues),
    plannedValueHash:
      text(row.plannedValueHash) ||
      hash(change && Object.hasOwn(change, "newValue") ? change.newValue : plannedMutation),
    writtenValueHash: text(row.writtenValueHash),
    sourceVersion: text(row.sourceVersion) || "target-snapshot-field-v1",
    sourceUpdatedAt: row.sourceUpdatedAt ? new Date(row.sourceUpdatedAt) : null,
  };
}

export const TARGET_SNAPSHOT_FIELD_REGISTRY_VERSION = "target-snapshot-field-v1";
