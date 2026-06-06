import { isNormalizedProductFilter } from "./productFilterCompiler.js";

function normalizeText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeMetafieldFilter(rawFilter) {
  const namespace = normalizeText(rawFilter?.namespace || rawFilter?.value?.namespace);
  const key = normalizeText(rawFilter?.key || rawFilter?.value?.key);
  const operator = normalizeText(rawFilter?.operator || "equals").toLowerCase();
  const valueRaw = rawFilter?.metafieldValue ?? rawFilter?.value?.value ?? rawFilter?.value;
  const value = typeof valueRaw === "object" ? normalizeText(valueRaw?.value) : normalizeText(valueRaw);
  const ownerType =
    rawFilter?.field === "variant_metafield" || rawFilter?.field === "variantMetafield"
      ? "VARIANT"
      : (normalizeText(rawFilter?.ownerType).toUpperCase() || "PRODUCT");

  if (!namespace || !key) return null;

  return { namespace, key, operator, value, ownerType };
}

function normalizeCollectionFilter(rawFilter) {
  const operator = normalizeText(rawFilter?.operator || "contains").toLowerCase();
  const rawValue = rawFilter?.value;
  if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
    const collectionId = normalizeText(rawValue.id || rawFilter?.collectionId);
    const title = normalizeText(rawValue.title || rawFilter?.collectionTitle || rawFilter?.value?.title);
    const handle = normalizeText(rawValue.handle || rawFilter?.collectionHandle || rawFilter?.value?.handle);
    if (!collectionId && !title && !handle && !["is empty", "is empty/blank", "is not empty"].includes(operator)) {
      return null;
    }
    return { operator, collectionId, title, handle };
  }

  const value = normalizeText(rawValue);
  if (!value && !["is empty", "is empty/blank", "is not empty"].includes(operator)) {
    return null;
  }
  return { operator, collectionId: "", title: value, handle: "" };
}

export function buildNormalizedFilterPlan(filterParams = []) {
  const plan = [];

  for (const rawFilter of filterParams) {
    const field = normalizeText(rawFilter?.field);
    if (!isNormalizedProductFilter(field)) continue;

    if (field === "collection" || field === "collections") {
      const collectionFilter = normalizeCollectionFilter(rawFilter);
      if (!collectionFilter) continue;
      plan.push({ type: "collection", ...collectionFilter });
      continue;
    }

    const metafield = normalizeMetafieldFilter(rawFilter);
    if (metafield) {
      plan.push({ type: "metafield", ...metafield });
    }
  }

  return plan;
}

export function mergeResolvedIdSets(steps = []) {
  let includeSet = null;
  const excludeSet = new Set();

  for (const step of steps) {
    const ids = Array.isArray(step?.ids) ? step.ids : [];
    const currentSet = new Set(ids);
    const normalizedOperator = String(step?.operator || "").toLowerCase();
    const isNegative =
      normalizedOperator === "is not" ||
      normalizedOperator === "does not equal" ||
      normalizedOperator === "does not contain";

    if (isNegative) {
      for (const id of currentSet) excludeSet.add(id);
      continue;
    }

    if (!includeSet) {
      includeSet = currentSet;
      continue;
    }

    const next = new Set();
    for (const id of includeSet) {
      if (currentSet.has(id)) next.add(id);
    }
    includeSet = next;
  }

  return {
    includeIds: includeSet ? Array.from(includeSet) : null,
    excludeIds: Array.from(excludeSet),
  };
}
