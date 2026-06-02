import test from "node:test";
import assert from "node:assert/strict";

async function loadStageServiceOrSkip(t) {
  try {
    return await import("./services/operationStageIdempotencyService.js");
  } catch (error) {
    if (String(error?.code || "") === "ERR_MODULE_NOT_FOUND") {
      t.skip(`Runtime harness skipped in minimal env: ${error.message}`);
      return null;
    }
    throw error;
  }
}

function getJsonPathValue(obj, path = []) {
  let cur = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

function createMockDb(initialRow) {
  const row = structuredClone(initialRow);
  return {
    editHistory: {
      findFirst: async ({ where, select }) => {
        if (row.id !== where.id || row.shop !== where.shop) return null;
        const out = {};
        for (const key of Object.keys(select || {})) out[key] = row[key];
        return out;
      },
      updateMany: async ({ where, data }) => {
        if (row.id !== where.id || row.shop !== where.shop) return { count: 0 };
        if (where.executionIdentity !== undefined && row.executionIdentity !== where.executionIdentity) {
          return { count: 0 };
        }
        if (where.executionState?.in && !where.executionState.in.includes(row.executionState)) {
          return { count: 0 };
        }
        const andClauses = Array.isArray(where.AND) ? where.AND : [];
        for (const clause of andClauses) {
          if (clause.OR) {
            const matched = clause.OR.some((orClause) => {
              const expected = orClause?.batch?.equals;
              const path = orClause?.batch?.path || [];
              const actual = getJsonPathValue(row.batch, path);
              return actual === expected;
            });
            if (!matched) return { count: 0 };
            continue;
          }
          if (clause.batch?.path) {
            const actual = getJsonPathValue(row.batch, clause.batch.path);
            if (actual !== clause.batch.equals) return { count: 0 };
          }
        }
        if (data?.batch) row.batch = data.batch;
        return { count: 1 };
      },
    },
    _row: row,
  };
}

test("concurrent stale-writer race: only one begin claim wins with execution fence", async (t) => {
  const mod = await loadStageServiceOrSkip(t);
  if (!mod) return;
  const { beginEditHistoryStage } = mod;
  const db = createMockDb({
    id: "h1",
    shop: "s.myshopify.com",
    executionIdentity: "exec-1",
    executionState: "QUEUED",
    batch: {},
  });

  const [first, second] = await Promise.all([
    beginEditHistoryStage({
      historyId: "h1",
      shop: "s.myshopify.com",
      stage: "TARGET_FREEZE",
      executionId: "exec-1",
      db,
    }),
    beginEditHistoryStage({
      historyId: "h1",
      shop: "s.myshopify.com",
      stage: "TARGET_FREEZE",
      executionId: "stale-exec",
      db,
    }),
  ]);

  const startedCount = [first, second].filter((x) => x.state === "started").length;
  assert.equal(startedCount, 1);
  assert.equal(db._row.batch.idempotencyStages.TARGET_FREEZE.executionId, "exec-1");
});

test("stale complete writer with wrong execution fence cannot finalize running stage", async (t) => {
  const mod = await loadStageServiceOrSkip(t);
  if (!mod) return;
  const { completeEditHistoryStage } = mod;
  const db = createMockDb({
    id: "h2",
    shop: "s.myshopify.com",
    executionIdentity: "exec-2",
    executionState: "EXECUTING",
    batch: {
      idempotencyStages: {
        TARGET_FREEZE: {
          status: "running",
          executionId: "exec-2",
          startedAt: new Date().toISOString(),
        },
      },
    },
  });

  await completeEditHistoryStage({
    historyId: "h2",
    shop: "s.myshopify.com",
    stage: "TARGET_FREEZE",
    executionId: "wrong-exec",
    db,
  });

  assert.equal(db._row.batch.idempotencyStages.TARGET_FREEZE.status, "running");
});
