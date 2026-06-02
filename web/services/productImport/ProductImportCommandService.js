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

export class ProductImportCommandService {
  constructor() {
    this.idempotencyStore = new IdempotencyStoreService(db);
  }

  async createImportCommand({
    shop,
    actor,
    file,
    columnMappings,
    subscription = null,
    idempotencyKey,
  }) {
    if (!shop) {
      const error = new Error("SHOP_REQUIRED");
      error.code = "VALIDATION_FAILED";
      throw error;
    }

    if (!file?.path) {
      const error = new Error("CSV_FILE_REQUIRED");
      error.code = "VALIDATION_FAILED";
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

    const begin = await this.idempotencyStore.begin({
      shop,
      scope: "IMPORT_CSV",
      key: idemKey,
      requestHash: buildIdempotencyRequestHash({
        shop,
        fileName: file.originalname || null,
        size: Number(file.size || 0),
        columnMappings,
      }),
    });
    if (begin.mode === "replay") {
      return begin.response;
    }

    await assertFeatureEntitlement({
      shop,
      feature: "IMPORT_CSV",
      subscription,
    });

    const newHistory = await db.editHistory.create({
      data: {
        shop,
        title: createMultiLanguageForFileEdit(file.originalname),
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

    await db.editHistory.update({
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

    const importDoc = await db.spreadsheetFile.create({
      data: {
        shop,
        editHistoryId: newHistory.id,
        columnMappings,
        fileUrl: file.path,
      },
    });

    await clearKeyCaches(`${shop}:fetchHistories`);

    await addbulkImportEditJob({
      historyId: newHistory.id,
      shop,
      filePath: file.path,
      columnMappings,
      source: "csv_import",
      executionId: newHistory.executionIdentity,
    });

    await clearAllCachesForShop(shop);

    const response = {
      operationId: newHistory.id,
      importId: importDoc.id,
      status: "QUEUED",
    };
    await this.idempotencyStore.complete({
      recordId: begin.recordId,
      response,
    });
    return response;
  }
}

export default ProductImportCommandService;

