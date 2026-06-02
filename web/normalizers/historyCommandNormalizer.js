import { NotFoundError } from "../utils/errorUtils.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const MAX_CURSOR_LENGTH = 500;
const MAX_SEARCH_LENGTH = 120;
const MAX_LANG_LENGTH = 16;
const MAX_TYPE_LENGTH = 64;
const MAX_ID_LENGTH = 128;
const EMPTY_ACTIVE_PLAN = Object.freeze({});

function buildRequestError(message, code = "VALIDATION_ERROR") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeOptionalPlainObject(value, fieldName) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw buildRequestError(`Invalid ${fieldName}`);
  }
  return Object.freeze({ ...value });
}

function normalizeActivePlan(value) {
  if (value === undefined || value === null) {
    return EMPTY_ACTIVE_PLAN;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw buildRequestError("Invalid active plan");
  }
  return Object.freeze({ ...value });
}

function assertContext(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw buildRequestError("Invalid command context");
  }
  if (!context.shop || typeof context.shop !== "string") {
    throw buildRequestError("Authentication required", "UNAUTHENTICATED");
  }
  return Object.freeze({
    shop: context.shop,
    actor: normalizeOptionalPlainObject(context.actor, "actor"),
    entitlement: normalizeOptionalPlainObject(context.entitlement, "entitlement"),
    subscription: normalizeOptionalPlainObject(context.subscription, "subscription"),
    activePlan: normalizeActivePlan(context.activePlan),
  });
}

function asObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw buildRequestError(`Invalid ${label}`);
  }
  return value;
}

function normalizeText(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseLimit(raw, fallback = DEFAULT_LIMIT) {
  const value = raw === undefined || raw === null || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw buildRequestError(`Invalid query: limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return value;
}

function parseOptionalCursor(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") {
    throw buildRequestError("Invalid query: cursor must be a string");
  }
  const value = raw.trim();
  if (value.length > MAX_CURSOR_LENGTH) {
    throw buildRequestError(`Invalid query: cursor must be <= ${MAX_CURSOR_LENGTH} chars`);
  }
  return value || null;
}

function parseOptionalLang(raw) {
  if (raw === undefined || raw === null || raw === "") return "en";
  if (typeof raw !== "string") {
    throw buildRequestError("Invalid query: lang must be a string");
  }
  const lang = raw.trim().toLowerCase();
  if (!lang || lang.length > MAX_LANG_LENGTH) {
    throw buildRequestError("Invalid query: lang is invalid");
  }
  return lang;
}

function parseOptionalType(raw) {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string") {
    throw buildRequestError("Invalid query: type must be a string");
  }
  const type = normalizeText(raw);
  if (type.length > MAX_TYPE_LENGTH) {
    throw buildRequestError(`Invalid query: type must be <= ${MAX_TYPE_LENGTH} chars`);
  }
  return type;
}

function parseOptionalSearch(raw) {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string") {
    throw buildRequestError("Invalid query: search must be a string");
  }
  const search = normalizeText(raw);
  if (search.length > MAX_SEARCH_LENGTH) {
    throw buildRequestError(`Invalid query: search must be <= ${MAX_SEARCH_LENGTH} chars`);
  }
  return search;
}

function parseRequiredId(rawId) {
  if (typeof rawId !== "string") {
    throw new NotFoundError("History id is required", "History id is required");
  }
  const id = rawId.trim();
  if (!id || id.length > MAX_ID_LENGTH || !/^[A-Za-z0-9._:-]+$/.test(id)) {
    throw new NotFoundError("Invalid history id", "History id not found");
  }
  return id;
}

export function buildExportHistoryListCommand({ query = {}, context }) {
  query = asObject(query, "query");
  const safeContext = assertContext(context);
  return Object.freeze({
    ...safeContext,
    lang: parseOptionalLang(query.lang),
    type: parseOptionalType(query.type),
    cursor: parseOptionalCursor(query.cursor),
    limit: parseLimit(query.limit, DEFAULT_LIMIT),
  });
}

export function buildExportHistoryDetailCommand({ params = {}, context }) {
  params = asObject(params, "params");
  const safeContext = assertContext(context);
  return Object.freeze({
    ...safeContext,
    id: parseRequiredId(params.id),
  });
}

export function buildEditHistoryListCommand({ query = {}, context }) {
  query = asObject(query, "query");
  const safeContext = assertContext(context);
  return Object.freeze({
    ...safeContext,
    lang: parseOptionalLang(query.lang),
    type: parseOptionalType(query.type),
    search: parseOptionalSearch(query.search),
    cursor: parseOptionalCursor(query.cursor),
    limit: parseLimit(query.limit, 10),
  });
}

export function buildEditHistoryDetailCommand({ params = {}, query = {}, context }) {
  params = asObject(params, "params");
  query = asObject(query, "query");
  const safeContext = assertContext(context);
  return Object.freeze({
    ...safeContext,
    id: parseRequiredId(params.id || query.id || query.historyId),
    lang: parseOptionalLang(query.lang),
  });
}

export function buildEditHistorySummaryCommand({ params = {}, query = {}, context }) {
  return buildEditHistoryDetailCommand({ params, query, context });
}

export function buildEditHistoryChangesCommand({ params = {}, query = {}, context }) {
  params = asObject(params, "params");
  query = asObject(query, "query");
  const safeContext = assertContext(context);
  return Object.freeze({
    ...safeContext,
    id: parseRequiredId(params.id || query.id || query.historyId),
    cursor: parseOptionalCursor(query.cursor),
    limit: parseLimit(query.limit, 10),
  });
}

export function buildImportHistoryListCommand({ query = {}, context }) {
  query = asObject(query, "query");
  const safeContext = assertContext(context);
  return Object.freeze({
    ...safeContext,
    cursor: parseOptionalCursor(query.cursor),
    limit: parseLimit(query.limit, 10),
  });
}

export function buildImportHistoryDetailCommand({ params = {}, context }) {
  params = asObject(params, "params");
  const safeContext = assertContext(context);
  return Object.freeze({
    ...safeContext,
    id: parseRequiredId(params.id),
  });
}
