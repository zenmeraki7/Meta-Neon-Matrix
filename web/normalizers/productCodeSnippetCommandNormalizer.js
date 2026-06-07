const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 500;
const MAX_CODE_LENGTH = 50_000;
const MAX_SEARCH_LENGTH = 200;
const MAX_LIST_LIMIT = 100;
const MAX_SEARCH_LIMIT = 25;
const MAX_CURSOR_LENGTH = 500;

const EMPTY_OBJECT = Object.freeze({});
const SNIPPET_STATUSES = new Set(["ACTIVE", "DRAFT", "ARCHIVED"]);
const SHOPIFY_PRODUCT_ID_PATTERN = /^(?:gid:\/\/shopify\/Product\/\d+|\d+)$/;

function buildRequestError(message, code = "VALIDATION_FAILED") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertNoPoisonKeys(value, fieldName) {
  if (!isPlainObject(value)) return;

  for (const key of Object.keys(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw buildRequestError(`Invalid ${fieldName}: unsafe key`);
    }
  }
}

function normalizeText(value, fieldName, maxLength = MAX_TEXT_LENGTH) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw buildRequestError(`Invalid ${fieldName}`);
  const text = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length > maxLength) throw buildRequestError(`Invalid ${fieldName}`);
  return text;
}

function normalizeRequiredText(value, fieldName, maxLength = MAX_TEXT_LENGTH) {
  const text = normalizeText(value, fieldName, maxLength);
  if (!text) throw buildRequestError(`${fieldName} is required`);
  return text;
}

function normalizeCode(value, fieldName = "code") {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw buildRequestError(`Invalid ${fieldName}`);
  if (value.includes("\u0000")) {
    throw buildRequestError(`Invalid ${fieldName}: null bytes not allowed`);
  }
  if (value.length > MAX_CODE_LENGTH) throw buildRequestError(`Invalid ${fieldName}`);
  return value;
}

function normalizeStatus(value) {
  const status = normalizeText(value, "status", 40);
  if (!status) return null;
  const upper = status.toUpperCase();
  if (!SNIPPET_STATUSES.has(upper)) throw buildRequestError("Unsupported snippet status");
  return upper;
}

function normalizeLimit(value, maxLimit = MAX_SEARCH_LIMIT) {
  if (value === undefined || value === null || value === "") return 20;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw buildRequestError(`Invalid limit: must be 1-${maxLimit}`);
  }
  return limit;
}

function normalizeCursor(value) {
  return normalizeText(value, "cursor", MAX_CURSOR_LENGTH);
}

function normalizeProductId(value) {
  const productId = normalizeRequiredText(value, "productId", MAX_ID_LENGTH);
  if (!SHOPIFY_PRODUCT_ID_PATTERN.test(productId)) {
    throw buildRequestError("Invalid productId");
  }
  return productId;
}

function normalizeActor(actor) {
  if (!actor) return null;
  if (!isPlainObject(actor)) throw buildRequestError("Invalid actor");
  assertNoPoisonKeys(actor, "actor");
  return Object.freeze({
    actorType: normalizeText(actor.actorType, "actorType", 80),
    actorId: normalizeText(actor.actorId, "actorId", 200),
    actorEmail: normalizeText(actor.actorEmail, "actorEmail", 320),
    actorName: normalizeText(actor.actorName, "actorName", 200),
  });
}

function buildBaseCommand({ shop, actor }) {
  return {
    shop: normalizeRequiredText(shop, "shop", 255),
    actor: normalizeActor(actor),
  };
}

function normalizeSnippetBody(body = {}, { partial = false } = {}) {
  const safeBody = isPlainObject(body) ? body : EMPTY_OBJECT;
  assertNoPoisonKeys(safeBody, "body");
  const title = partial
    ? normalizeText(safeBody.title, "title")
    : normalizeRequiredText(safeBody.title, "title");
  const code = normalizeCode(safeBody.code);

  if (!partial && code === null) throw buildRequestError("code is required");

  return Object.freeze({
    ...(title !== null ? { title } : {}),
    ...(code !== null ? { code } : {}),
    ...(safeBody.status !== undefined ? { status: normalizeStatus(safeBody.status) } : {}),
  });
}

export function buildCreateProductCodeSnippetCommand({ shop, actor, body }) {
  return Object.freeze({
    ...buildBaseCommand({ shop, actor }),
    body: normalizeSnippetBody(body),
  });
}

export function buildListProductCodeSnippetsCommand({ shop, actor, query = {} }) {
  const safeQuery = isPlainObject(query) ? query : EMPTY_OBJECT;
  assertNoPoisonKeys(safeQuery, "query");
  return Object.freeze({
    ...buildBaseCommand({ shop, actor }),
    query: Object.freeze({
      search: normalizeText(safeQuery.search, "search", MAX_SEARCH_LENGTH) || "",
      status: normalizeStatus(safeQuery.status),
      limit: normalizeLimit(safeQuery.limit, MAX_LIST_LIMIT),
      cursor: normalizeCursor(safeQuery.cursor),
    }),
  });
}

export function buildGetProductCodeSnippetCommand({ shop, actor, params = {} }) {
  return Object.freeze({
    ...buildBaseCommand({ shop, actor }),
    productCodeSnippetId: normalizeRequiredText(params.id, "productCodeSnippetId", MAX_ID_LENGTH),
  });
}

export function buildUpdateProductCodeSnippetCommand({ shop, actor, params = {}, body }) {
  return Object.freeze({
    ...buildGetProductCodeSnippetCommand({ shop, actor, params }),
    body: normalizeSnippetBody(body, { partial: true }),
  });
}

export function buildDeleteProductCodeSnippetCommand({ shop, actor, params = {} }) {
  return buildGetProductCodeSnippetCommand({ shop, actor, params });
}

export function buildValidateProductCodeSnippetCommand({ shop, actor, params = {} }) {
  return buildGetProductCodeSnippetCommand({ shop, actor, params });
}

export function buildPreviewProductCodeSnippetCommand({ shop, actor, params = {}, body = {} }) {
  const safeBody = isPlainObject(body) ? body : EMPTY_OBJECT;
  assertNoPoisonKeys(safeBody, "body");
  return Object.freeze({
    ...buildGetProductCodeSnippetCommand({ shop, actor, params }),
    productId: normalizeProductId(safeBody.productId),
  });
}

export function buildSearchSnippetPreviewProductsCommand({ shop, actor, query = {} }) {
  const safeQuery = isPlainObject(query) ? query : EMPTY_OBJECT;
  assertNoPoisonKeys(safeQuery, "query");
  return Object.freeze({
    ...buildBaseCommand({ shop, actor }),
    search: normalizeText(safeQuery.search, "search", MAX_SEARCH_LENGTH) || "",
    limit: normalizeLimit(safeQuery.limit, MAX_SEARCH_LIMIT),
  });
}
