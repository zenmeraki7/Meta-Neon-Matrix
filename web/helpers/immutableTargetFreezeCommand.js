import {
  buildImmutablePayloadMetadata,
  verifyImmutablePayload,
} from "../utils/immutablePayloadUtils.js";

export function targetFreezeAuthorityPayload(command) {
  return {
    shop: command.shop,
    operationId: command.operationId ?? null,
    sourceType: command.sourceType,
    sourceId: command.sourceId,
    sourceRevision: command.sourceRevision ?? null,
    ruleConfigHash: command.ruleConfigHash ?? null,
    mirrorBatchId: command.mirrorBatchId ?? null,
    targetResolutionMode: command.targetResolutionMode ?? null,
    filterAst: command.filterAst ?? null,
    savedTargetSetId: command.savedTargetSetId ?? null,
    editOperationJson: command.editOperationJson ?? null,
  };
}

export function immutableTargetFreezeCommand(data) {
  return {
    ...data,
    ...buildImmutablePayloadMetadata({
      payload: targetFreezeAuthorityPayload(data),
      operationType: "OPERATION_ENQUEUE_INTENT",
    }),
  };
}

export function verifyTargetFreezeCommand(command) {
  return verifyImmutablePayload(targetFreezeAuthorityPayload(command), {
    operationType: "OPERATION_ENQUEUE_INTENT",
    payloadHash: command.payloadHash,
    payloadByteSize: command.payloadByteSize,
    payloadSchemaVersion: command.payloadSchemaVersion,
    payloadCompression: command.payloadCompression,
    payloadStorageKey: command.payloadStorageKey,
  });
}
