const MAX_TEXT = 500;
const MAX_LIMIT = 250;
const MAX_ID = 200;

function buildError(message, code = "VALIDATION_FAILED") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeText(value, field, max = MAX_TEXT) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw buildError(`Invalid ${field}`);
  const text = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length > max) throw buildError(`Invalid ${field}`);
  return text;
}

function normalizeLimit(value, fallback = 20) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw buildError("Invalid limit");
  }
  return n;
}

function assertContext({ shop, actor }) {
  const safeShop = normalizeText(shop, "shop", 255);
  if (!safeShop) throw buildError("Authentication required", "UNAUTHENTICATED");
  return Object.freeze({
    shop: safeShop,
    actor: actor || null,
  });
}

export function buildProductQueryCommand({ shop, actor, query = {}, body = {} }) {
  const ctx = assertContext({ shop, actor });
  if (query?.page && String(query.page) !== "1") {
    throw buildError("Offset pagination is disabled for product listing. Use cursor pagination.");
  }
  return Object.freeze({
    ...ctx,
    query: query && typeof query === "object" ? query : {},
    body: body && typeof body === "object" ? body : {},
  });
}

export function buildBulkEditStatusCommand({ shop, actor, params = {} }) {
  const ctx = assertContext({ shop, actor });
  const id = normalizeText(params?.id, "id", MAX_ID);
  if (!id) throw buildError("historyId is required");
  return Object.freeze({ ...ctx, historyId: id });
}

export function buildProductTypeOptionsCommand({ shop, actor, query = {} }) {
  const ctx = assertContext({ shop, actor });
  return Object.freeze({
    ...ctx,
    search: normalizeText(query?.search, "search", 100) || "",
    limit: normalizeLimit(query?.limit, 20),
  });
}

export function buildProductFilterValueOptionsCommand({
  shop,
  actor,
  params = {},
  query = {},
}) {
  const ctx = assertContext({ shop, actor });
  const field = normalizeText(params?.field, "field", 160);
  if (!field) throw buildError("field is required");
  return Object.freeze({
    ...ctx,
    field,
    search: normalizeText(query?.search, "search", 100) || "",
    limit: normalizeLimit(query?.limit, 20),
  });
}

export function buildFilterRegistryCommand({ shop, actor }) {
  const ctx = assertContext({ shop, actor });
  return Object.freeze({ ...ctx });
}
