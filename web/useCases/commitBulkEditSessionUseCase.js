import { toSessionCommitResultDto } from "../dtos/sessionDto.js";
import { JobCreationService } from "../services/JobCreationService.js";

export async function commitBulkEditSessionUseCase(command) {
  let created;
  try {
    created = await JobCreationService.createAndEnqueue({
      shopId: command.shopId,
      operationType: "BULK_WRITE",
      queueName: process.env.METAFIELD_BULK_WRITE_QUEUE || "metafield-bulk-write",
      workerClass: "metafield-bulk-write",
      idempotencyKey:
        command.idempotencyKey || `bulk-write:${command.shopId}:${command.sessionId}`,
      payload: { sessionId: command.sessionId },
    });
  } catch (error) {
    const knownCode = String(error?.code || error?.message || "").trim();
    if (["SESSION_NOT_FOUND", "SESSION_NOT_OPEN", "NO_PENDING_CHANGES"].includes(knownCode)) {
      error.code = knownCode;
      throw error;
    }
    const wrapped = new Error("BULK_WRITE_JOB_CREATION_FAILED", { cause: error });
    wrapped.code = "BULK_WRITE_JOB_CREATION_FAILED";
    wrapped.statusCode = 503;
    wrapped.retryable = true;
    throw wrapped;
  }
  const job = created.jobRecord;

  return toSessionCommitResultDto({
    jobId: job.id,
    sessionId: command.sessionId,
    changeCount: job.changeCount ?? job.total_count ?? 0,
  });
}
