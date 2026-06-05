import crypto from "crypto";
import { requireShopScope } from "../../utils/shopScope.js";
import { sha256Stable, stableStringify } from "../../utils/canonicalJson.js";

const IDEMPOTENCY_STATE_IN_PROGRESS = "IN_PROGRESS";
const IDEMPOTENCY_STATE_COMPLETED = "COMPLETED";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

function sha256(input) {
  return crypto.createHash("sha256").update(String(input || "")).digest("hex");
}

function buildConflictError(code, message, detail = {}) {
  const error = new Error(message || code);
  error.code = "CONFLICT";
  error.publicCode = code;
  Object.assign(error, detail);
  return error;
}

function buildValidationError(code) {
  const error = new Error(code);
  error.code = "VALIDATION_FAILED";
  return error;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function assertRecordShape(record) {
  if (
    !record ||
    typeof record !== "object" ||
    !record.id ||
    !record.shop ||
    !record.scope ||
    !record.key ||
    !record.requestHash ||
    !record.state
  ) {
    throw new Error("IDEMPOTENCY_RECORD_MALFORMED");
  }
}

export function buildIdempotencyRequestHash(payload) {
  return sha256Stable(payload);
}

export function buildIdempotencyRecordId({ shop, scope, key }) {
  const scopedShop = requireShopScope(shop);
  return `idem_${sha256(`${scopedShop}:${scope}:${key}`)}`;
}

export class IdempotencyStoreService {
  constructor(db, options = {}) {
    if (!db) {
      throw new Error("IDEMPOTENCY_DB_REQUIRED");
    }
    this.db = db;
    this.ttlMs = parsePositiveInteger(
      options.ttlMs ?? process.env.IDEMPOTENCY_RECORD_TTL_MS,
      DEFAULT_TTL_MS,
    );
    this.maxResponseBytes = parsePositiveInteger(
      options.maxResponseBytes ?? process.env.IDEMPOTENCY_RESPONSE_MAX_BYTES,
      DEFAULT_MAX_RESPONSE_BYTES,
    );
  }

  async begin({ shop, scope, key, requestHash }, attempt = 0) {
    const scopedShop = requireShopScope(shop);
    const safeScope = String(scope || "").trim();
    const safeKey = String(key || "").trim();
    const safeRequestHash = String(requestHash || "").trim();
    if (!safeScope || !safeKey || !safeRequestHash) {
      throw buildValidationError("IDEMPOTENCY_INPUT_INVALID");
    }

    const recordId = buildIdempotencyRecordId({
      shop: scopedShop,
      scope: safeScope,
      key: safeKey,
    });
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.ttlMs);
    const inserted = await this.#insertIfAbsent({
      id: recordId,
      shop: scopedShop,
      scope: safeScope,
      key: safeKey,
      requestHash: safeRequestHash,
      expiresAt,
    });

    if (inserted) {
      return { mode: "execute", recordId };
    }

    const existing = await this.db.idempotencyRecord.findFirst({
      where: { id: recordId, shop: scopedShop },
    });
    if (!existing) {
      throw buildConflictError(
        "IDEMPOTENCY_RECORD_CONFLICT_LOST",
        "Idempotency record conflicted but disappeared before it could be resolved.",
      );
    }

    if (existing.expiresAt && new Date(existing.expiresAt).getTime() <= now.getTime()) {
      const deleted = await this.db.idempotencyRecord.deleteMany({
        where: {
          id: recordId,
          shop: scopedShop,
          expiresAt: { lte: now },
        },
      });
      if (deleted.count > 0 && attempt < 1) {
        return this.begin(
          {
            shop: scopedShop,
            scope: safeScope,
            key: safeKey,
            requestHash: safeRequestHash,
          },
          attempt + 1,
        );
      }
    }

    return this.#resolveExisting(existing, safeRequestHash);
  }

  async complete({ recordId, shop, response }) {
    if (!recordId) return;
    const scopedShop = requireShopScope(shop);
    this.#assertResponseWithinLimit(response);

    const update = await this.db.idempotencyRecord.updateMany({
      where: {
        id: recordId,
        shop: scopedShop,
        state: IDEMPOTENCY_STATE_IN_PROGRESS,
      },
      data: {
        state: IDEMPOTENCY_STATE_COMPLETED,
        response,
        completedAt: new Date(),
      },
    });

    if (update.count > 0) return;

    const existing = await this.db.idempotencyRecord.findFirst({
      where: { id: recordId, shop: scopedShop },
    });
    if (!existing) {
      throw new Error("IDEMPOTENCY_RECORD_NOT_FOUND");
    }
    assertRecordShape(existing);
    if (existing.state === IDEMPOTENCY_STATE_COMPLETED) return;
    throw new Error("IDEMPOTENCY_RECORD_NOT_IN_PROGRESS");
  }

  async abort({ recordId, shop }) {
    if (!recordId) return;
    const scopedShop = requireShopScope(shop);
    await this.db.idempotencyRecord.deleteMany({
      where: {
        id: recordId,
        shop: scopedShop,
        state: IDEMPOTENCY_STATE_IN_PROGRESS,
      },
    });
  }

  #resolveExisting(record, requestHash) {
    assertRecordShape(record);
    const existingHash = String(record.requestHash || "");

    if (!existingHash || existingHash !== String(requestHash)) {
      throw buildConflictError(
        "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
        "Idempotency key was reused with a different payload.",
      );
    }

    if (record.state === IDEMPOTENCY_STATE_COMPLETED) {
      return {
        mode: "replay",
        response: record.response,
        recordId: record.id,
      };
    }

    const startedAt = record.createdAt ? new Date(record.createdAt) : null;
    const expiresAt = record.expiresAt ? new Date(record.expiresAt) : null;
    const retryAfterSeconds = expiresAt
      ? Math.max(1, Math.min(60, Math.ceil((expiresAt.getTime() - Date.now()) / 1000)))
      : 5;
    throw buildConflictError(
      "IDEMPOTENCY_REQUEST_IN_PROGRESS",
      "A request with this idempotency key is already in progress.",
      {
        retryAfterSeconds,
        startedAt: startedAt?.toISOString?.() || null,
        expiresAt: expiresAt?.toISOString?.() || null,
      },
    );
  }

  async #insertIfAbsent(record) {
    if (typeof this.db.$queryRaw === "function") {
      const rows = await this.db.$queryRaw`
        INSERT INTO "IdempotencyRecord"
          ("id", "shop", "scope", "key", "requestHash", "state", "expiresAt")
        VALUES
          (${record.id}, ${record.shop}, ${record.scope}, ${record.key}, ${record.requestHash}, ${IDEMPOTENCY_STATE_IN_PROGRESS}, ${record.expiresAt})
        ON CONFLICT ("id") DO NOTHING
        RETURNING "id"
      `;
      return Array.isArray(rows) && rows.length > 0;
    }

    try {
      await this.db.idempotencyRecord.create({
        data: {
          ...record,
          state: IDEMPOTENCY_STATE_IN_PROGRESS,
        },
      });
      return true;
    } catch (error) {
      if (error?.code === "P2002") return false;
      throw error;
    }
  }

  #assertResponseWithinLimit(response) {
    const serialized = stableStringify(response);
    const bytes = Buffer.byteLength(serialized || "null", "utf8");
    if (bytes > this.maxResponseBytes) {
      throw buildValidationError("IDEMPOTENCY_RESPONSE_TOO_LARGE");
    }
  }
}

export default IdempotencyStoreService;
