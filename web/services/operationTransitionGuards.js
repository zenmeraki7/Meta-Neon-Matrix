import { db as repositoryDb } from "../repositories/repositoryDb.js";
import {
  normalizeEditHistoryExecutionState,
  normalizeEditHistoryStatus,
} from "../utils/normalizedStateUtils.js";

const db = repositoryDb;

export async function guardedEditHistoryUpdate({
  id,
  shop,
  expectedExecutionStates = [],
  expectedStatuses = [],
  extraWhere = {},
  data,
  db = repositoryDb,
}) {
  const where = {
    id,
    shop,
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

  const result = await db.editHistory.updateMany({ where, data });
  return result.count === 1;
}
