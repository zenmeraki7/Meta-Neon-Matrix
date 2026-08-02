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

  async begin({ shop, scope, key, requestHash, lockTtlMs = 60000, dbClient = null }) {
    const scopedShop = requireShopScope(shop);
    if (!scope || !key || !requestHash) {
      const error = new Error("IDEMPOTENCY_INPUT_INVALID");
      error.code = "VALIDATION_FAILED";
      throw error;
    }

    const recordId = buildIdempotencyRecordId({ shop: scopedShop, scope, key });
    const ownerToken = crypto.randomUUID();
    const lockedUntil = new Date(Date.now() + lockTtlMs);
    const client = dbClient || this.db;

    if (client.idempotencyRecord) {
      const existing = await client.idempotencyRecord.findUnique({
        where: { id: recordId },
      });

      if (existing) {
        return this.#resolveExistingIdempotencyRecord(existing, requestHash, ownerToken, lockedUntil, client);
      }

      try {
        await client.idempotencyRecord.create({
          data: {
            id: recordId,
            shop: scopedShop,
            scope,
            key,
            requestHash,
            state: "IN_PROGRESS",
            ownerToken,
            lockedUntil,
          },
        });
        return { mode: "execute", recordId, ownerToken };
      } catch (error) {
        if (error?.code !== "P2002") {
          throw error;
        }

        const concurrent = await client.idempotencyRecord.findUnique({
          where: { id: recordId },
        });
        if (!concurrent) {
          throw error;
        }
        return this.#resolveExistingIdempotencyRecord(concurrent, requestHash, ownerToken, lockedUntil, client);
      }
    } else {
      // Legacy fallback for FilterTrack or mock object in tests
      const existing = await client.filterTrack.findUnique({
        where: { id: recordId },
      });
      if (existing) {
        return this.#resolveExisting(existing, requestHash);
      }

      try {
        await client.filterTrack.create({
          data: {
            id: recordId,
            shop: scopedShop,
            type: IDEMPOTENCY_TYPE,
            field: scope,
            searchKey: key,
            value: {
              state: "IN_PROGRESS",
              requestHash,
              ownerToken,
              lockedUntil: lockedUntil.toISOString(),
            },
          },
        });
        return { mode: "execute", recordId, ownerToken };
      } catch (error) {
        if (error?.code !== "P2002") {
          throw error;
        }

        const concurrent = await client.filterTrack.findUnique({
          where: { id: recordId },
        });
        if (!concurrent) {
          throw error;
        }
        return this.#resolveExisting(concurrent, requestHash);
      }
    }
  }

  async complete({ recordId, shop, ownerToken, response, resourceType = null, resourceId = null, dbClient = null }) {
    if (!recordId) return;
    const client = dbClient || this.db;

    if (client.idempotencyRecord) {
      const updated = await client.idempotencyRecord.updateMany({
        where: {
          id: recordId,
          ...(shop ? { shop: requireShopScope(shop) } : {}),
          state: "IN_PROGRESS",
          ...(ownerToken ? { ownerToken } : {}),
        },
        data: {
          state: "COMPLETED",
          responseJson: response,
          resourceType: resourceType || null,
          resourceId: resourceId || null,
          lockedUntil: null,
          ownerToken: null,
        },
      });

      if (updated.count !== 1) {
        const error = new Error("IDEMPOTENCY_OWNERSHIP_LOST");
        error.code = "IDEMPOTENCY_OWNERSHIP_LOST";
        throw error;
      }
    } else {
      // Legacy fallback for FilterTrack or mock object in tests
      const existing = await client.filterTrack.findUnique({
        where: { id: recordId },
      });
      const existingValue = asObject(existing?.value);
      await client.filterTrack.update({
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
  }

  async #resolveExistingIdempotencyRecord(record, requestHash, newOwnerToken, newLockedUntil, client) {
    const existingHash = String(record?.requestHash || "");

    if (!existingHash || existingHash !== String(requestHash)) {
      throw buildConflictError(
        "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
        "Idempotency key was reused with a different payload.",
      );
    }

    if (record.state === "COMPLETED" && record.responseJson && typeof record.responseJson === "object") {
      return {
        mode: "replay",
        response: record.responseJson,
        recordId: record.id,
      };
    }

    // Check if in progress and lock has expired (safe takeover)
    const isLocked = record.lockedUntil && new Date(record.lockedUntil) > new Date();
    if (!isLocked && record.state === "IN_PROGRESS") {
      const tookOver = await client.idempotencyRecord.updateMany({
        where: {
          id: record.id,
          state: "IN_PROGRESS",
          lockedUntil: record.lockedUntil,
        },
        data: {
          ownerToken: newOwnerToken,
          lockedUntil: newLockedUntil,
        },
      });
      if (tookOver.count === 1) {
        return { mode: "execute", recordId: record.id, ownerToken: newOwnerToken };
      }
    }

    throw buildConflictError(
      "IDEMPOTENCY_REQUEST_IN_PROGRESS",
      "A request with this idempotency key is already in progress.",
    );
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
