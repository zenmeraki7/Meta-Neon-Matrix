import crypto from "crypto";
import { db } from "../../repositories/repositoryDb.js";
import { createMultiLanguageForFileEdit } from "../../utils/googleTranslator.js";
import { clearAllCachesForShop, clearKeyCaches } from "../../utils/cacheUtils.js";
import { addbulkImportEditJob } from "../../Jobs/Queues/bulkImportEditJob.js";
import {
  BULK_EDIT_EXECUTION_STATES,
  buildPlannedUndoState,
} from "../bulkEditExecutionStateService.js";
import { buildImmutableEditCommand } from "../bulkEdit/immutableEditCommand.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../../utils/normalizedStateUtils.js";
import { assertFeatureEntitlement } from "../entitlement/featureEntitlementService.js";
import {
  buildIdempotencyRequestHash,
  IdempotencyStoreService,
} from "../idempotency/IdempotencyStoreService.js";
import { canonicalizeMappings } from "../storage/immutableObjectStorage.js";

export class ProductImportCommandService {
  constructor(dbClient = null) {
    this.dbClient = dbClient;
    this.idempotencyStore = new IdempotencyStoreService(dbClient || db);
  }

  async createImportCommand({
    shop,
    actor,
    uploadToken,
    columnMappings,
    subscription = null,
    idempotencyKey,
    dbClient = null,
  }) {
    const database = dbClient || this.dbClient || db;
    const idempotencyStore = dbClient ? new IdempotencyStoreService(dbClient) : this.idempotencyStore;

    if (!shop) {
      const error = new Error("SHOP_REQUIRED");
      error.code = "VALIDATION_FAILED";
      throw error;
    }

    if (!uploadToken) {
      const error = new Error("UPLOAD_TOKEN_REQUIRED");
      error.code = "VALIDATION_FAILED";
      throw error;
    }

    const upload = await database.spreadsheetFile.findFirst({
      where: {
        id: uploadToken,
        shop,
        status: "PREVIEW_READY",
      },
      select: {
        id: true,
        storageKey: true,
        contentSha256: true,
        sizeBytes: true,
        originalFilename: true,
      },
    });

    if (!upload) {
      const error = new Error("PREVIEW_NOT_FOUND");
      error.code = "PREVIEW_NOT_FOUND";
      throw error;
    }

    if (!columnMappings || typeof columnMappings !== "object" || Array.isArray(columnMappings)) {
      const error = new Error("INVALID_COLUMN_MAPPINGS");
      error.code = "VALIDATION_FAILED";
      throw error;
    }
    const idemKey = String(idempotencyKey || "").trim();
    if (!idemKey) {
      const error = new Error("IDEMPOTENCY_KEY_REQUIRED");
      error.code = "VALIDATION_FAILED";
      throw error;
    }

    const requestHash = buildIdempotencyRequestHash({
      shop,
      uploadToken: upload.id,
      contentSha256: upload.contentSha256,
      columnMappings: canonicalizeMappings(columnMappings),
    });

    const begin = await idempotencyStore.begin({
      shop,
      scope: "IMPORT_CSV",
      key: idemKey,
      requestHash,
    });
    if (begin.mode === "replay") {
      return begin.response;
    }

    await assertFeatureEntitlement({
      shop,
      feature: "IMPORT_CSV",
      subscription,
    });

    const newHistory = await database.editHistory.create({
      data: {
        shop,
        title: createMultiLanguageForFileEdit(upload.originalFilename || "import.csv"),
        editedType: "mixed",
        startedAt: new Date(),
        status: "pending",
        statusNormalized: normalizeEditHistoryStatus("pending"),
        executionState: BULK_EDIT_EXECUTION_STATES.PLANNED,
        executionStateNormalized: normalizeEditHistoryExecutionState(
          BULK_EDIT_EXECUTION_STATES.PLANNED,
        ),
        executionIdentity: crypto.randomUUID(),
        isSpreadsheetEdit: true,
        undo: buildPlannedUndoState({ allowed: true }),
        rules: [{ field: "mixed" }],
        batch: {
          csvImport: true,
          lastProductId: null,
          hasMore: false,
          size: 0,
        },
        actorType: actor?.actorType || null,
        actorId: actor?.actorId || null,
        actorEmail: actor?.actorEmail || null,
      },
    });

    await database.editHistory.update({
      where: { id: newHistory.id },
      data: {
        batch: {
          ...(newHistory.batch && typeof newHistory.batch === "object" ? newHistory.batch : {}),
          immutableEditCommand: buildImmutableEditCommand({
            operationType: "BULK_PRODUCT_EDIT",
            shop,
            actorUserId: null,
            edit: [{ field: "mixed", operator: "CSV_IMPORT", value: null }],
            targetSnapshotSetId: `EDIT_HISTORY:${newHistory.id}`,
          }),
        },
      },
    });

    await database.spreadsheetFile.updateMany({
      where: { id: upload.id, shop },
      data: {
        editHistoryId: newHistory.id,
        columnMappings,
        executionClaimedAt: new Date(),
        status: "EXECUTION_CLAIMED",
      },
    });

    await clearKeyCaches(`${shop}:fetchHistories`);

    try {
      await addbulkImportEditJob({
        historyId: newHistory.id,
        shop,
        executionId: newHistory.executionIdentity,
      });
    } catch (error) {
      await database.editHistory.updateMany({
        where: { id: newHistory.id, shop },
        data: {
          status: "failed",
          statusNormalized: normalizeEditHistoryStatus("failed"),
          executionState: BULK_EDIT_EXECUTION_STATES.FAILED,
          executionStateNormalized: normalizeEditHistoryExecutionState(
            BULK_EDIT_EXECUTION_STATES.FAILED,
          ),
          error: {
            code: "CSV_IMPORT_QUEUE_ADD_FAILED",
            message: error?.message || "Failed to enqueue CSV import job",
          },
        },
      });
      throw error;
    }

    await clearAllCachesForShop(shop);

    const response = {
      operationId: newHistory.id,
      importId: upload.id,
      status: "QUEUED",
    };
    await idempotencyStore.complete({
      recordId: begin.recordId,
      response,
    });
    return response;
  }
}

export default ProductImportCommandService;

