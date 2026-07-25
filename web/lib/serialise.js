/**
 * Recursively converts BigInt values to strings.
 * @param {any} value
 * @returns {any}
 */
function serialiseValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => serialiseValue(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = serialiseValue(val);
    }
    return out;
  }
  return value;
}

/**
 * Serialises a single row-like object safely for JSON.
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
export function serialiseRow(row) {
  return serialiseValue(row || {});
}

/**
 * Serialises array rows safely for JSON.
 * @param {Array<Record<string, any>>} rows
 * @returns {Array<Record<string, any>>}
 */
export function serialiseRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => serialiseRow(row));
}

/**
 * Sends JSON response with BigInt-safe serialisation.
 * @param {import("express").Response} res
 * @param {any} data
 * @param {number} [status=200]
 * @returns {import("express").Response}
 */
export function jsonResponse(res, data, status = 200) {
  return res.status(status).json(serialiseValue(data));
}

