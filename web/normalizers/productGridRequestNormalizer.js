function badRequest(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

export function normalizeProductGridQuery(query = {}) {
  const rawLimit = Number.parseInt(String(query.limit || "50"), 10);
  const limit = Math.max(1, Math.min(200, Number.isFinite(rawLimit) ? rawLimit : 50));

  const cursor = query.cursor ? String(query.cursor) : null;
  if (cursor) {
    try {
      JSON.parse(Buffer.from(String(cursor), "base64").toString("utf8"));
    } catch {
      throw badRequest("INVALID_CURSOR", "Invalid cursor");
    }
  }

  const status = query.status ? String(query.status).toUpperCase() : null;
  if (status && !["ACTIVE", "ARCHIVED", "DRAFT"].includes(status)) {
    throw badRequest("INVALID_STATUS", "Invalid status filter");
  }

  return Object.freeze({
    limit,
    cursor,
    search: query.search ? String(query.search) : null,
    status,
    vendor: query.vendor ? String(query.vendor) : null,
    productType: query.productType ? String(query.productType) : null,
    tag: query.tag ? String(query.tag) : null,
  });
}
