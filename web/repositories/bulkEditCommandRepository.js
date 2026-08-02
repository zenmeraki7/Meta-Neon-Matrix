import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../config/database.js";
import { OPERATION_LIFECYCLE_STATES } from "../services/operationLifecycleStateMachine.js";
import { normalizeEditHistoryExecutionState } from "../utils/normalizedStateUtils.js";
import { reserveUsageInTransaction } from "../services/usageLedgerService.js";

function buildRepositoryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export function hashCommand(command) {
  return createHash("sha256")
    .update(canonicalJson(command))
    .digest("hex");
}

export function assertValidImmutableEditCommand(command) {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    throw buildRepositoryError(
      "INVALID_IMMUTABLE_EDIT_COMMAND",
      "Invalid immutable edit command",
    );
  }

  if (!Object.isFrozen(command)) {
    throw buildRepositoryError(
      "MUTABLE_IMMUTABLE_EDIT_COMMAND",
      "Immutable edit command must be deeply frozen",
    );
  }
}

async function runSerializableTransaction(work, maxAttempts = 3) {
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;

    try {
      return await prisma.$transaction(work, {
        isolationLevel: "Serializable",
      });
    } catch (error) {
      const retryable = error?.code === "P2034";

      if (!retryable || attempt === maxAttempts) {
        throw error;
      }
    }
  }

  throw new Error("Unreachable transaction retry state");
}

export async function findPreviewContractRecord(
  previewContractIdOrOptions,
  shopArg,
) {
  const options =
    typeof previewContractIdOrOptions === "object" && previewContractIdOrOptions !== null
      ? previewContractIdOrOptions
      : { previewContractId: previewContractIdOrOptions, shop: shopArg };

  const { previewContractId, shop, tx = prisma } = options;

  return tx.filterTrack.findFirst({
    where: {
      id: String(previewContractId),
      shop,
      type: "preview",
      changeSource: "manual_preview", // source: "manual_preview"

    },
  });
}

export async function findExecutablePreviewContractRecord({
  previewContractId,
  shop,
  now = new Date(),
  tx = prisma,
}) {
  return tx.filterTrack.findFirst({
    where: {
      id: String(previewContractId),
      shop,
      type: "preview",
      changeSource: "manual_preview", // source: "manual_preview"

      status: "APPROVED",
      expiresAt: {
        gt: now,
      },
      executionId: null,
    },
    select: {
      id: true,
      shop: true,
      status: true,
      expiresAt: true,
      revision: true,
      contractHash: true,
      executionId: true,
      filterJson: true,
      explicitProductIds: true,
    },
  });
}

export async function extendPreviewContractExpiry({
  previewContractId,
  shop,
  expectedRevision,
  expiresAt,
  now = new Date(),
  tx = prisma,
}) {
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
    throw new TypeError("expiresAt must be a valid Date");
  }

  if (expiresAt <= now) {
    throw buildRepositoryError(
      "INVALID_PREVIEW_EXPIRY",
      "Preview expiry must be in the future",
    );
  }

  const result = await tx.filterTrack.updateMany({
    where: {
      id: String(previewContractId),
      shop,
      type: "preview",
      changeSource: "manual_preview", // source: "manual_preview"

      status: {
        in: ["DRAFT", "READY_FOR_REVIEW"],
      },
      executionId: null,
      revision: expectedRevision,
      expiresAt: {
        gt: now,
      },
    },
    data: {
      expiresAt,
      revision: {
        increment: 1,
      },
    },
  });

  if (result.count !== 1) {
    throw buildRepositoryError(
      "PREVIEW_EXPIRY_EXTENSION_CONFLICT",
      "Preview contract was not found or is no longer extendable",
    );
  }

  return {
    previewContractId: String(previewContractId),
    revision: expectedRevision + 1,
    expiresAt,
  };
}

function buildManualEditHistoryCreateData({
  shop,
  executionIdentity,
  actor,
  editType,
  editedField,
  targetCount,
  batch,
  idempotencyKey,
}) {
  return {
    shop,
    executionIdentity,
    actorType: actor?.type || "SHOPIFY_USER",
    actorId: actor?.id ?? null,
    editType,
    editedField,
    totalItems: targetCount ?? 0,
    idempotencyKey,
    batch,
    executionState: OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
    executionStateNormalized: normalizeEditHistoryExecutionState(
      OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
    ),
  };
}

export async function createManualEditHistoryWithImmutableCommand({
  shop,
  executionIdentity,
  actor,
  editType,
  editedField,
  targetCount,
  initialBatch,
  idempotencyKey,
  immutableEditCommand,
  buildImmutableEditCommandForHistory,
  usageReservation,
  previewContractId,
  expectedPreviewRevision,
  now = new Date(),
}) {
  if (!idempotencyKey) {
    throw buildRepositoryError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "An idempotency key is required for manual edit creation",
    );
  }

  let finalCommand = immutableEditCommand;
  if (!finalCommand && typeof buildImmutableEditCommandForHistory === "function") {
    const raw = buildImmutableEditCommandForHistory({
      shop,
      executionIdentity,
    });
    finalCommand = Object.isFrozen(raw) ? raw : Object.freeze(raw);
  }

  assertValidImmutableEditCommand(finalCommand);
  const payloadHash = hashCommand(finalCommand);

  return runSerializableTransaction(async (tx) => {
    const idempotency = await tx.operationIdempotency
      .create({
        data: {
          shop,
          scope: "MANUAL_BULK_EDIT_CREATE",
          idempotencyKey,
          payloadHash,
          status: "PROCESSING",
        },
        select: {
          id: true,
        },
      })
      .catch(async (error) => {
        if (error?.code !== "P2002") {
          throw error;
        }

        const existing = await tx.operationIdempotency.findUnique({
          where: {
            shop_scope_idempotencyKey: {
              shop,
              scope: "MANUAL_BULK_EDIT_CREATE",
              idempotencyKey,
            },
          },
          select: {
            payloadHash: true,
            status: true,
            resultId: true,
          },
        });

        if (!existing || existing.payloadHash !== payloadHash) {
          const conflict = new Error(
            "Idempotency key was reused with a different payload",
          );
          conflict.code = "IDEMPOTENCY_PAYLOAD_CONFLICT";
          throw conflict;
        }

        return {
          replay: true,
          existing,
        };
      });

    if (idempotency.replay) {
      return {
        id: idempotency.existing.resultId,
        historyId: idempotency.existing.resultId,
        historyShop: shop,
        executionIdentity,
        replayed: true,
      };
    }

    const historyId = randomUUID();

    if (previewContractId) {
      const claimed = await tx.filterTrack.updateMany({
        where: {
          id: String(previewContractId),
          shop,
          type: "preview",
          changeSource: "manual_preview",
          status: "APPROVED",
          revision: expectedPreviewRevision,
          expiresAt: { gt: now },
          executionId: null,
        },
        data: {
          status: "EXECUTION_CREATED",
          executionId: historyId,
          revision: { increment: 1 },
        },
      });

      if (claimed.count !== 1) {
        throw buildRepositoryError(
          "PREVIEW_NOT_EXECUTABLE",
          "The preview is expired, already executed, or has changed",
        );
      }
    }

    const history = await tx.editHistory.create({
      data: {
        id: historyId,
        ...buildManualEditHistoryCreateData({
          shop,
          executionIdentity,
          actor,
          editType,
          editedField,
          targetCount,
          batch: initialBatch,
          idempotencyKey,
        }),
      },
      select: {
        id: true,
        shop: true,
        executionIdentity: true,
      },
    });

    const snapshotSet = await tx.targetSnapshotSet.create({
      data: {
        shop: history.shop,
        ownerType: "EDIT_HISTORY",
        ownerId: history.id,
        sourceType:
          Array.isArray(initialBatch?.explicitProductIds) &&
          initialBatch.explicitProductIds.length > 0
            ? "MANUAL_SELECTION"
            : "FILTER",
        status: OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
        revision: 1,
      },
      select: {
        id: true,
        revision: true,
      },
    });

    await tx.immutableEditCommand.create({
      data: {
        shop: history.shop,
        historyId: history.id,
        executionIdentity: history.executionIdentity,
        revision: 1,
        command: finalCommand,
        commandHash: payloadHash,
        payload: finalCommand,
        payloadHash: payloadHash,
      },
    });

    if (usageReservation) {
      await reserveUsageInTransaction({
        units: usageReservation.units,
        quantity: usageReservation.quantity,
        entitlementKey: usageReservation.entitlementKey,
        idempotencyKey: usageReservation.idempotencyKey,
        metadata: usageReservation.metadata,

        // Trusted repository-owned values must remain last.
        tx,
        shop: history.shop,
        operationType: "BULK_EDIT",
        operationId: history.id,
      });
    }

    const updated = await tx.editHistory.updateMany({
      where: {
        id: history.id,
        shop: history.shop,
        executionState: OPERATION_LIFECYCLE_STATES.TARGET_FREEZING,
      },
      data: {
        snapshotSetId: snapshotSet.id,
      },
    });

    if (updated.count !== 1) {
      throw buildRepositoryError(
        "EDIT_HISTORY_CREATION_CONFLICT",
        "Edit history changed while the manual edit was being created",
      );
    }

    await tx.outboxEvent.create({
      data: {
        shop: history.shop,
        aggregateType: "EDIT_HISTORY",
        aggregateId: history.id,
        eventType: "MANUAL_EDIT_QUEUED",
        deduplicationKey: `MANUAL_EDIT_QUEUED:${history.shop}:${history.id}`,
        payload: {
          historyId: history.id,
          executionIdentity: history.executionIdentity,
          commandRevision: 1,
          snapshotSetId: snapshotSet.id,
          snapshotRevision: snapshotSet.revision,
        },
        status: "PENDING",
        availableAt: new Date(),
      },
    });

    await tx.operationIdempotency.update({
      where: {
        shop_scope_idempotencyKey: {
          shop,
          scope: "MANUAL_BULK_EDIT_CREATE",
          idempotencyKey,
        },
      },
      data: {
        status: "COMPLETED",
        resultId: history.id,
      },
    });

    return {
      id: history.id,
      historyId: history.id,
      historyShop: history.shop,
      executionIdentity: history.executionIdentity,
      history,
      snapshotSetId: snapshotSet.id,
    };
  });
}
