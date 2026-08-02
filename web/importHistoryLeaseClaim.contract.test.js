import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { claimImportHistory } from "./Jobs/Workers/bulkImportEditWorker.js";

function createFakeLeaseDb() {
  const editHistories = new Map();

  const dbClient = {
    editHistory: {
      async updateMany({ where, data }) {
        let count = 0;
        for (const [id, record] of editHistories.entries()) {
          if (where.id && record.id !== where.id) continue;
          if (where.shop && record.shop !== where.shop) continue;

          let matchesOr = false;
          if (where.OR && Array.isArray(where.OR)) {
            for (const cond of where.OR) {
              let match = true;
              if (cond.executionStateNormalized && record.executionStateNormalized !== cond.executionStateNormalized) {
                match = false;
              }
              if (cond.statusNormalized && record.statusNormalized !== cond.statusNormalized) {
                match = false;
              }
              if (cond.executionLeaseUntil?.lt) {
                if (!record.executionLeaseUntil || !(record.executionLeaseUntil < cond.executionLeaseUntil.lt)) {
                  match = false;
                }
              }
              if (match) {
                matchesOr = true;
                break;
              }
            }
          }

          if (matchesOr) {
            const updated = {
              ...record,
              status: data.status,
              statusNormalized: data.statusNormalized || data.status?.toUpperCase(),
              executionState: data.executionState,
              executionStateNormalized: data.executionStateNormalized || data.executionState?.toUpperCase(),
              executionOwnerId: data.executionOwnerId,
              executionLeaseUntil: data.executionLeaseUntil,
              executionHeartbeatAt: data.executionHeartbeatAt,
              stateVersion: (record.stateVersion || 0) + (data.stateVersion?.increment || 1),
            };
            editHistories.set(id, updated);
            count++;
          }
        }
        return { count };
      },
      async count({ where }) {
        let count = 0;
        for (const record of editHistories.values()) {
          if (where.id && record.id !== where.id) continue;
          if (where.shop && record.shop !== where.shop) continue;
          if (where.executionOwnerId && record.executionOwnerId !== where.executionOwnerId) continue;
          if (where.executionLeaseUntil?.gt) {
            if (!record.executionLeaseUntil || !(record.executionLeaseUntil > where.executionLeaseUntil.gt)) continue;
          }
          if (where.executionStateNormalized) {
            if (typeof where.executionStateNormalized === "string") {
              if (record.executionStateNormalized !== where.executionStateNormalized) continue;
            } else if (where.executionStateNormalized.in) {
              if (!where.executionStateNormalized.in.includes(record.executionStateNormalized)) continue;
            }
          }
          count++;
        }
        return count;
      },
    },
  };

  return { editHistories, dbClient };
}

test("schema.prisma defines executionOwnerId, executionLeaseUntil, executionHeartbeatAt on EditHistory", () => {
  const schema = fs.readFileSync(new URL("./prisma/schema.prisma", import.meta.url), "utf8");
  assert.ok(schema.includes("executionOwnerId          String?"), "executionOwnerId missing in schema.prisma");
  assert.ok(schema.includes("executionLeaseUntil       DateTime?"), "executionLeaseUntil missing in schema.prisma");
  assert.ok(schema.includes("executionHeartbeatAt      DateTime?"), "executionHeartbeatAt missing in schema.prisma");
});

test("migration file contains executionOwnerId, executionLeaseUntil, executionHeartbeatAt columns", () => {
  const migration = fs.readFileSync(
    new URL("./prisma/migrations/20260730150000_add_edit_history_execution_lease_fields/migration.sql", import.meta.url),
    "utf8",
  );
  assert.ok(migration.includes('ALTER TABLE "EditHistory" ADD COLUMN IF NOT EXISTS "executionOwnerId"'), "executionOwnerId column missing");
  assert.ok(migration.includes('ALTER TABLE "EditHistory" ADD COLUMN IF NOT EXISTS "executionLeaseUntil"'), "executionLeaseUntil column missing");
  assert.ok(migration.includes('ALTER TABLE "EditHistory" ADD COLUMN IF NOT EXISTS "executionHeartbeatAt"'), "executionHeartbeatAt column missing");
});

test("claimImportHistory claims PLANNED/PENDING history and sets ownerId and leaseUntil", async () => {
  const { editHistories, dbClient } = createFakeLeaseDb();
  editHistories.set("hist_1", {
    id: "hist_1",
    shop: "store.myshopify.com",
    statusNormalized: "PENDING",
    executionStateNormalized: "PLANNED",
    stateVersion: 0,
  });

  const claimed = await claimImportHistory({
    historyId: "hist_1",
    shop: "store.myshopify.com",
    ownerId: "csv-import:job1:owner1",
    leaseMs: 300000,
    dbClient,
  });

  assert.equal(claimed, true);
  const record = editHistories.get("hist_1");
  assert.equal(record.executionOwnerId, "csv-import:job1:owner1");
  assert.equal(record.statusNormalized, "PROCESSING");
  assert.equal(record.executionStateNormalized, "TARGET_FREEZING");
  assert.equal(record.stateVersion, 1);
  assert.ok(record.executionLeaseUntil instanceof Date);
});

test("claimImportHistory blocks concurrent worker claim when lease is active", async () => {
  const { editHistories, dbClient } = createFakeLeaseDb();
  const futureLease = new Date(Date.now() + 300000);
  editHistories.set("hist_2", {
    id: "hist_2",
    shop: "store.myshopify.com",
    statusNormalized: "PROCESSING",
    executionStateNormalized: "TARGET_FREEZING",
    executionOwnerId: "csv-import:job1:owner1",
    executionLeaseUntil: futureLease,
    stateVersion: 1,
  });

  const claimed = await claimImportHistory({
    historyId: "hist_2",
    shop: "store.myshopify.com",
    ownerId: "csv-import:job2:owner2",
    leaseMs: 300000,
    dbClient,
  });

  assert.equal(claimed, false);
  const record = editHistories.get("hist_2");
  assert.equal(record.executionOwnerId, "csv-import:job1:owner1");
});

test("claimImportHistory reclaims stalled job when lease is expired", async () => {
  const { editHistories, dbClient } = createFakeLeaseDb();
  const pastLease = new Date(Date.now() - 10000);
  editHistories.set("hist_3", {
    id: "hist_3",
    shop: "store.myshopify.com",
    statusNormalized: "PROCESSING",
    executionStateNormalized: "TARGET_FREEZING",
    executionOwnerId: "stalled_owner",
    executionLeaseUntil: pastLease,
    stateVersion: 1,
  });

  const claimed = await claimImportHistory({
    historyId: "hist_3",
    shop: "store.myshopify.com",
    ownerId: "csv-import:job3:new_owner",
    leaseMs: 300000,
    dbClient,
  });

  assert.equal(claimed, true);
  const record = editHistories.get("hist_3");
  assert.equal(record.executionOwnerId, "csv-import:job3:new_owner");
  assert.equal(record.stateVersion, 2);
});

test("revalidation fails when ownerId mismatches or lease is expired", async () => {
  const { editHistories, dbClient } = createFakeLeaseDb();
  const pastLease = new Date(Date.now() - 1000);
  editHistories.set("hist_4", {
    id: "hist_4",
    shop: "store.myshopify.com",
    statusNormalized: "PROCESSING",
    executionStateNormalized: "TARGET_FREEZING",
    executionOwnerId: "csv-import:job4:owner4",
    executionLeaseUntil: pastLease,
  });

  const count = await dbClient.editHistory.count({
    where: {
      id: "hist_4",
      shop: "store.myshopify.com",
      executionOwnerId: "csv-import:job4:owner4",
      executionLeaseUntil: { gt: new Date() },
      executionStateNormalized: "TARGET_FREEZING",
    },
  });

  assert.equal(count, 0);
});
