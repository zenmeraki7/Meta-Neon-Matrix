import { db as repositoryDb } from "../repositories/repositoryDb.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../utils/normalizedStateUtils.js";

const db = repositoryDb;

export async function guardedEditHistoryUpdate({
  id,
  shop,
  expectedExecutionStates,
  expectedStatuses = [],
  expectedStateVersion,
  extraWhere = {},
  data,
  tx,
  db,
}) {
  const targetClient = tx || db || repositoryDb;
  const where = {
    id,
    shop,
    ...(expectedStateVersion !== null && expectedStateVersion !== undefined
      ? { stateVersion: Number(expectedStateVersion) }
      : {}),
    ...(Array.isArray(expectedExecutionStates) && expectedExecutionStates.length
      ? {
        executionStateNormalized: {
          in: [...new Set(expectedExecutionStates.map(normalizeEditHistoryExecutionState))],
        },
      }
      : {}),
    ...(Array.isArray(expectedStatuses) && expectedStatuses.length
      ? {
        statusNormalized: {
          in: [...new Set(expectedStatuses.map(normalizeEditHistoryStatus))],
        },
      }
      : {}),
    ...(extraWhere && typeof extraWhere === "object" ? extraWhere : {}),
  };

  const updateData = {
    ...data,
    stateVersion: { increment: 1 },
  };

  const result = await targetClient.editHistory.updateMany({ where, data: updateData });
  if (result.count === 1) {
    const newVersion =
      expectedStateVersion !== undefined && expectedStateVersion !== null
        ? Number(expectedStateVersion) + 1
        : null;
    return {
      success: true,
      count: 1,
      newVersion,
    };
  }

  return {
    success: false,
    count: 0,
    newVersion: null,
  };
}

