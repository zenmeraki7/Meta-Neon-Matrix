import { commitSessionAtomically } from "../repositories/sessionCommitRepository.js";
import { enqueueBulkEditWrite } from "../queues/adapters/bulkEditQueueAdapter.js";
import { toSessionCommitResultDto } from "../dtos/sessionDto.js";

export async function commitBulkEditSessionUseCase(command) {
  const committed = await commitSessionAtomically(command.sessionId, command.shopId);
  const queued = await enqueueBulkEditWrite({
    shopId: committed.shopId,
    sessionId: committed.sessionId,
    changeCount: committed.changeCount,
  });

  return toSessionCommitResultDto({
    jobId: queued.jobId,
    sessionId: committed.sessionId,
    changeCount: committed.changeCount,
  });
}
