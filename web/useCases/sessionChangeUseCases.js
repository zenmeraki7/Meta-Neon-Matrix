import {
  findSessionScoped,
  writeColumnAppliedSessionChanges,
  writeStagedSessionChanges,
} from "../repositories/sessionChangeRepository.js";
import { toSessionChangeResultDto } from "../dtos/sessionDto.js";

async function assertDraftSession(sessionId, shopId) {
  const session = await findSessionScoped(sessionId, shopId);
  if (!session) {
    const error = new Error("Session not found");
    error.statusCode = 404;
    error.code = "SESSION_NOT_FOUND";
    throw error;
  }
  if (String(session.status) !== "DRAFT") {
    const error = new Error("Session is not open");
    error.statusCode = 409;
    error.code = "SESSION_NOT_OPEN";
    throw error;
  }
}

export async function stageSessionChanges(command) {
  const { shopId, sessionId, changes } = command;
  await assertDraftSession(sessionId, shopId);
  await writeStagedSessionChanges(sessionId, shopId, changes);
  return toSessionChangeResultDto({ staged: changes.length });
}

export async function applyColumnSessionChanges(command) {
  const { shopId, sessionId, namespace, key, value, variantIds } = command;
  await assertDraftSession(sessionId, shopId);
  const result = await writeColumnAppliedSessionChanges(
    sessionId,
    shopId,
    namespace,
    key,
    value,
    variantIds,
  );
  return toSessionChangeResultDto({ staged: Number(result?.staged || 0) });
}
