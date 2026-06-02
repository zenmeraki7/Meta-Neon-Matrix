import { db } from "../repositories/repositoryDb.js";

export async function guardedEditHistoryUpdate({
  id,
  shop,
  expectedExecutionStates = [],
  expectedStatuses = [],
  extraWhere = {},
  data,
  db = db,
}) {
  const where = {
    id,
    shop,
    ...(Array.isArray(expectedExecutionStates) && expectedExecutionStates.length
      ? { executionState: { in: expectedExecutionStates } }
      : {}),
    ...(Array.isArray(expectedStatuses) && expectedStatuses.length
      ? { status: { in: expectedStatuses } }
      : {}),
    ...(extraWhere && typeof extraWhere === "object" ? extraWhere : {}),
  };

  const result = await db.editHistory.updateMany({ where, data });
  return result.count === 1;
}

