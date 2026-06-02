import crypto from "crypto";
import { requireShopScope } from "../../utils/shopScope.js";

const IDEMPOTENCY_TYPE = "filter";

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

function sha256(input) {
  return crypto.createHash("sha256").update(String(input || "")).digest("hex");
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function buildConflictError(code, message) {
  const error = new Error(message || code);
  error.code = "CONFLICT";
  error.publicCode = code;
  return error;
}

export function buildIdempotencyRequestHash(payload) {
  return sha256(stableStringify(payload));
}

export function buildIdempotencyRecordId({ shop, scope, key }) {
  const scopedShop = requireShopScope(shop);
  return `idem_${sha256(`${scopedShop}:${scope}:${key}`).slice(0, 40)}`;
}

export class IdempotencyStoreService {
  constructor(db) {
    if (!db) {
      throw new Error("IDEMPOTENCY_DB_REQUIRED");
    }
    this.db = db;
  }

  async begin({ shop, scope, key, requestHash }) {
    const scopedShop = requireShopScope(shop);
    if (!scope || !key || !requestHash) {
      const error = new Error("IDEMPOTENCY_INPUT_INVALID");
      error.code = "VALIDATION_FAILED";
      throw error;
    }

    const recordId = buildIdempotencyRecordId({ shop: scopedShop, scope, key });
    const existing = await this.db.filterTrack.findUnique({
      where: { id: recordId },
    });
    if (existing) {
      return this.#resolveExisting(existing, requestHash);
    }

    try {
      await this.db.filterTrack.create({
        data: {
          id: recordId,
          shop: scopedShop,
          type: IDEMPOTENCY_TYPE,
          field: scope,
          searchKey: key,
          value: {
            state: "IN_PROGRESS",
            requestHash,
          },
        },
      });
      return { mode: "execute", recordId };
    } catch (error) {
      if (error?.code !== "P2002") {
        throw error;
      }

      const concurrent = await this.db.filterTrack.findUnique({
        where: { id: recordId },
      });
      if (!concurrent) {
        throw error;
      }
      return this.#resolveExisting(concurrent, requestHash);
    }
  }

  async complete({ recordId, response }) {
    if (!recordId) return;
    const existing = await this.db.filterTrack.findUnique({
      where: { id: recordId },
    });
    const existingValue = asObject(existing?.value);
    await this.db.filterTrack.update({
      where: { id: recordId },
      data: {
        value: {
          requestHash: existingValue.requestHash || null,
          state: "COMPLETED",
          response,
        },
      },
    });
  }

  #resolveExisting(record, requestHash) {
    const value = asObject(record?.value);
    const existingHash = String(value.requestHash || "");

    if (!existingHash || existingHash !== String(requestHash)) {
      throw buildConflictError(
        "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
        "Idempotency key was reused with a different payload.",
      );
    }

    if (value.state === "COMPLETED" && value.response && typeof value.response === "object") {
      return {
        mode: "replay",
        response: value.response,
        recordId: record.id,
      };
    }

    throw buildConflictError(
      "IDEMPOTENCY_REQUEST_IN_PROGRESS",
      "A request with this idempotency key is already in progress.",
    );
  }
}

export default IdempotencyStoreService;
