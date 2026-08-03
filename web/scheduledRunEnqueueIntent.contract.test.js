import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function read(relPath) {
  return fs.readFileSync(new URL(relPath, import.meta.url), "utf8");
}

test("OperationEnqueueIntent uniqueness is delegated to a scoped SQL partial index", () => {
  const schema = read("./prisma/schema.prisma");
  assert.equal(schema.includes("@@unique([shop, dispatchDedupeKey]"), false);
  assert.ok(schema.includes("dispatchScope String"));
});

test("migration SQL creates the scoped partial unique index concurrently", () => {
  const migration = read(
    "./prisma/migrations/20260801101000_enqueue_intent_partial_unique_concurrently/migration.sql",
  );
  assert.ok(migration.includes("CREATE UNIQUE INDEX"));
  assert.ok(migration.includes('("shop", "dispatchScope", "dedupeKey")'));
  assert.ok(migration.includes('WHERE "dedupeKey" IS NOT NULL'), "migration index must filter WHERE dedupeKey IS NOT NULL");
});

test("scheduledExportExecutionService creates run, advances schedule, and creates enqueue intent in same transaction", () => {
  const src = read("./services/scheduledExportExecutionService.js");
  assert.ok(src.includes("scheduledExportRunRepository.create("), "Must create scheduledExportRun in tx");
  assert.ok(src.includes("scheduledExportRepository.updateByIdForShop("), "Must update schedule in tx");
  assert.ok(src.includes("createEnqueueIntent({"), "Must create enqueue intent in tx");
  assert.ok(src.includes('queueRoutingKey: "SCHEDULED_EXPORT_RUN"'), "Must use SCHEDULED_EXPORT_RUN routing key");
  assert.ok(src.includes("dispatchDedupeKey: `scheduled-export-run:${run.id}`"), "Dedupe key must contain immutable run id");

  // Verify post-commit direct enqueueing is removed
  const startIdx = src.indexOf("export async function scheduleDueScheduledExportRuns");
  const endIdx = src.indexOf("export async function executeScheduledExportRun");
  const fnBody = src.slice(startIdx, endIdx);
  assert.equal(
    fnBody.includes("await enqueueScheduledExportExecutionJob({"),
    false,
    "Direct post-commit enqueueing must be removed from scheduleDueScheduledExportRuns",
  );
});

test("recurringEditExecutionService creates run, advances schedule, and creates enqueue intent in same transaction", () => {
  const src = read("./services/recurringEditExecutionService.js");
  assert.ok(src.includes("recurringEditRunRepository.create("), "Must create recurringEditRun in tx");
  assert.ok(src.includes("recurringEditRepository.updateByIdForShop("), "Must update schedule in tx");
  assert.ok(src.includes("createEnqueueIntent({"), "Must create enqueue intent in tx");
  assert.ok(src.includes('queueRoutingKey: "RECURRING_EDIT_RUN"'), "Must use RECURRING_EDIT_RUN routing key");
  assert.ok(src.includes("dispatchDedupeKey: `recurring-edit-run:${run.id}`"), "Dedupe key must contain immutable run id");

  // Verify post-commit direct enqueueing is removed
  const startIdx = src.indexOf("export async function scheduleDueRecurringEditRuns");
  const endIdx = src.indexOf("export async function executeRecurringEditRun");
  const fnBody = src.slice(startIdx, endIdx);
  assert.equal(
    fnBody.includes("await enqueueRecurringEditExecutionJob({"),
    false,
    "Direct post-commit enqueueing must be removed from scheduleDueRecurringEditRuns",
  );
});

test("legacy PENDING run recovery functions exist for scheduled export and recurring edit runs", () => {
  const exportSrc = read("./services/scheduledExportExecutionService.js");
  const editSrc = read("./services/recurringEditExecutionService.js");

  assert.ok(exportSrc.includes("export async function recoverLegacyPendingScheduledExportRuns"), "recoverLegacyPendingScheduledExportRuns missing");
  assert.ok(editSrc.includes("export async function recoverLegacyPendingRecurringEditRuns"), "recoverLegacyPendingRecurringEditRuns missing");
});

test("enqueue intent service handles SCHEDULED_EXPORT_RUN and RECURRING_EDIT_RUN dispatching", () => {
  const src = read("./services/operationEnqueueIntentService.js");
  assert.ok(src.includes('SCHEDULED_EXPORT_RUN: "SCHEDULED_EXPORT_RUN"'), "SCHEDULED_EXPORT_RUN key missing");
  assert.ok(src.includes('RECURRING_EDIT_RUN: "RECURRING_EDIT_RUN"'), "RECURRING_EDIT_RUN key missing");
  assert.ok(src.includes("enqueueScheduledExportExecutionJob(payload, options)"), "SCHEDULED_EXPORT_RUN dispatch missing");
  assert.ok(src.includes("enqueueRecurringEditExecutionJob(payload, options)"), "RECURRING_EDIT_RUN dispatch missing");
});

test("recoverLegacyPendingScheduledExportRuns recovers PENDING runs lacking enqueue intents", async () => {
  const { recoverLegacyPendingScheduledExportRuns } = await import("./services/scheduledExportExecutionService.js");

  const runs = [
    { id: "run_1", shop: "store.myshopify.com", scheduledExportId: "export_1", scheduledFor: new Date() },
  ];
  const createdIntents = [];

  const fakeDb = {
    scheduledExportRun: {
      async findMany() {
        return runs;
      },
    },
    operationEnqueueIntent: {
      async findFirst() {
        return createdIntents.at(-1) || null;
      },
      async createMany({ data }) {
        createdIntents.push(...data);
        return { count: data.length };
      },
    },
    async $transaction(fn) {
      return fn(fakeDb);
    },
  };

  const result = await recoverLegacyPendingScheduledExportRuns({ limit: 10, dbClient: fakeDb });
  assert.equal(result.recovered, 1);
  assert.equal(createdIntents.length, 1);
  assert.equal(createdIntents[0].dispatchDedupeKey, "scheduled-export-run:run_1");
  assert.equal(createdIntents[0].queueRoutingKey, "SCHEDULED_EXPORT_RUN");
});

test("recoverLegacyPendingRecurringEditRuns recovers PENDING runs lacking enqueue intents", async () => {
  const { recoverLegacyPendingRecurringEditRuns } = await import("./services/recurringEditExecutionService.js");

  const runs = [
    { id: "run_2", shop: "store.myshopify.com", recurringEditId: "edit_1", scheduledFor: new Date() },
  ];
  const createdIntents = [];

  const fakeDb = {
    recurringEditRun: {
      async findMany() {
        return runs;
      },
    },
    operationEnqueueIntent: {
      async findFirst() {
        return createdIntents.at(-1) || null;
      },
      async createMany({ data }) {
        createdIntents.push(...data);
        return { count: data.length };
      },
    },
    async $transaction(fn) {
      return fn(fakeDb);
    },
  };

  const result = await recoverLegacyPendingRecurringEditRuns({ limit: 10, dbClient: fakeDb });
  assert.equal(result.recovered, 1);
  assert.equal(createdIntents.length, 1);
  assert.equal(createdIntents[0].dispatchDedupeKey, "recurring-edit-run:run_2");
  assert.equal(createdIntents[0].queueRoutingKey, "RECURRING_EDIT_RUN");
});
