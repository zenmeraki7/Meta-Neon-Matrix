import {
  findSessionScoped,
  writeColumnAppliedSessionChanges,
  writeStagedSessionChanges,
} from "../repositories/sessionChangeRepository.js";
import { toSessionChangeResultDto } from "../dtos/sessionDto.js";

async function assertDraftSession(sessionId, shopDomain) {
  const session = await findSessionScoped(sessionId, shopDomain);
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
  const { shopDomain, sessionId, changes } = command;
  await assertDraftSession(sessionId, shopDomain);
  await writeStagedSessionChanges(sessionId, shopDomain, changes);
  return toSessionChangeResultDto({ staged: changes.length });
}

export async function applyColumnSessionChanges(command) {
  const { shopDomain, sessionId, namespace, key, value, variantIds } = command;
  await assertDraftSession(sessionId, shopDomain);
  const result = await writeColumnAppliedSessionChanges(
    sessionId,
    shopDomain,
    namespace,
    key,
    value,
    variantIds,
  );
  return toSessionChangeResultDto({ staged: Number(result?.staged || 0) });
}
