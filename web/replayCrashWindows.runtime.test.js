import test from "node:test";
import assert from "node:assert/strict";

function withPatched(obj, key, replacement) {
  const original = obj[key];
  obj[key] = replacement;
  return () => {
    obj[key] = original;
  };
}

test("scheduled export finalize replay is duplicate-safe after crash window", async (t) => {
  let finalizeScheduledExportRunFromExportJob;
  let prisma;
  let scheduledExportRunRepository;
  let scheduledExportRepository;
  try {
    ({ finalizeScheduledExportRunFromExportJob } = await import("./services/scheduledExportExecutionService.js"));
    ({ prisma } = await import("./config/database.js"));
    ({ scheduledExportRunRepository } = await import("./repositories/scheduledExportRunRepository.js"));
    ({ scheduledExportRepository } = await import("./repositories/scheduledExportRepository.js"));
  } catch (error) {
    t.skip(`Runtime harness skipped in minimal env: ${String(error?.message || error)}`);
    return;
  }

  const restore = [];
  const state = {
    runStatus: "PROCESSING",
    historyCreated: 0,
    scheduledUpdated: 0,
    transitionCalls: 0,
  };

  restore.push(withPatched(prisma.exportJob, "findUnique", async () => ({
    scheduledExportId: "se1",
    scheduledExportRunId: "run1",
    downloadUrl: "https://example.com/file.csv",
    totalItems: 10,
    durationMs: 1000,
    completedAt: new Date(),
    status: "COMPLETED",
    error: null,
    shop: "shop-a.myshopify.com",
    filename: "file.csv",
  })));

  restore.push(withPatched(scheduledExportRunRepository, "findById", async () => ({
    id: "run1",
    status: state.runStatus,
  })));
  restore.push(withPatched(scheduledExportRunRepository, "markProcessingFinished", async () => {
    state.transitionCalls += 1;
    if (state.runStatus !== "PROCESSING") return { count: 0 };
    state.runStatus = "SUCCESS";
    return { count: 1 };
  }));
  restore.push(withPatched(prisma.exportHistory, "findFirst", async () =>
    (state.historyCreated > 0 ? { id: "eh1" } : null)));
  restore.push(withPatched(prisma.exportHistory, "create", async () => {
    state.historyCreated += 1;
    return { id: `eh${state.historyCreated}` };
  }));
  restore.push(withPatched(scheduledExportRepository, "updateByIdForShop", async () => {
    state.scheduledUpdated += 1;
    return { count: 1 };
  }));

  try {
    const first = await finalizeScheduledExportRunFromExportJob({
      exportJobId: "ej1",
      shop: "shop-a.myshopify.com",
      status: "SUCCESS",
    });
    assert.equal(first, "SUCCESS");
    assert.equal(state.historyCreated, 1);
    assert.equal(state.scheduledUpdated, 1);

    const replay = await finalizeScheduledExportRunFromExportJob({
      exportJobId: "ej1",
      shop: "shop-a.myshopify.com",
      status: "SUCCESS",
    });
    assert.equal(replay, "SUCCESS");
    assert.equal(state.historyCreated, 1, "replay must not create duplicate export history");
    assert.equal(state.scheduledUpdated, 1, "replay must not increment run counters again");
    assert.ok(state.transitionCalls >= 1);
  } finally {
    for (const undo of restore.reverse()) undo();
  }
});

test("automatic rule finalize rejects stale processing token replay", async (t) => {
  let finalizeAutomaticProductRuleRunFromHistory;
  let prisma;
  let automaticProductRuleRunRepository;
  let automaticProductRuleRepository;
  try {
    ({ finalizeAutomaticProductRuleRunFromHistory } = await import("./services/automaticProductRuleExecutionService.js"));
    ({ prisma } = await import("./config/database.js"));
    ({ automaticProductRuleRunRepository } = await import("./repositories/automaticProductRuleRunRepository.js"));
    ({ automaticProductRuleRepository } = await import("./repositories/automaticProductRuleRepository.js"));
  } catch (error) {
    t.skip(`Runtime harness skipped in minimal env: ${String(error?.message || error)}`);
    return;
  }

  const restore = [];
  const state = {
    runStatus: "PROCESSING",
    token: "token-live",
    finishCalls: 0,
    ruleUpdateCalls: 0,
  };

  restore.push(withPatched(prisma.editHistory, "findUnique", async () => ({
    shop: "shop-a.myshopify.com",
    automaticProductRuleId: "rule1",
    automaticProductRuleRunId: "run1",
    batch: {},
    status: "completed",
    completedAt: new Date(),
  })));
  restore.push(withPatched(automaticProductRuleRunRepository, "findByIdForShop", async () => ({
    id: "run1",
    shop: "shop-a.myshopify.com",
    status: state.runStatus,
    processingToken: state.token,
  })));
  restore.push(withPatched(automaticProductRuleRunRepository, "markProcessingFinishedWithTokenForShop", async ({ processingToken }) => {
    state.finishCalls += 1;
    if (state.runStatus !== "PROCESSING" || processingToken !== state.token) return { count: 0 };
    state.runStatus = "SUCCESS";
    return { count: 1 };
  }));
  restore.push(withPatched(automaticProductRuleRepository, "updateByIdForShop", async () => {
    state.ruleUpdateCalls += 1;
    return { count: 1 };
  }));

  try {
    const stale = await finalizeAutomaticProductRuleRunFromHistory({
      historyId: "h1",
      status: "SUCCESS",
      processingToken: "stale-token",
    });
    assert.equal(stale, "PROCESSING");
    assert.equal(state.ruleUpdateCalls, 0, "stale token must not finalize rule counters");

    const fresh = await finalizeAutomaticProductRuleRunFromHistory({
      historyId: "h1",
      status: "SUCCESS",
      processingToken: "token-live",
    });
    assert.equal(fresh, "SUCCESS");
    assert.equal(state.ruleUpdateCalls, 1);
    assert.ok(state.finishCalls >= 2);
  } finally {
    for (const undo of restore.reverse()) undo();
  }
});

