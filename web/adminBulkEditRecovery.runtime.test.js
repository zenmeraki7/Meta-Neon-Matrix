import test from "node:test";
import assert from "node:assert/strict";

function createRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function loadRuntimeOrSkip(t) {
  try {
    const serviceMod = await import("./services/bulkEdit/BulkEditRecoveryService.js");
    const controllerMod = await import("./controllers/adminController.js");
    return {
      BulkEditRecoveryService: serviceMod.BulkEditRecoveryService,
      recoverStuckBulkEditOperation: controllerMod.recoverStuckBulkEditOperation,
      __setBulkEditRecoveryServiceFactory: controllerMod.__setBulkEditRecoveryServiceFactory,
    };
  } catch (error) {
    const message = String(error?.message || error || "");
    if (
      message.includes("generated/prisma/index.js")
      || message.includes("generated\\prisma\\index.js")
      || message.includes("ERR_MODULE_NOT_FOUND")
      || message.includes("Cannot find package")
    ) {
      t.skip(`Runtime harness skipped in minimal env: ${message}`);
      return null;
    }
    throw error;
  }
}

test("recovery service verify mode uses lease + CAS + verification enqueue", async (t) => {
  const mods = await loadRuntimeOrSkip(t);
  if (!mods) return;
  const { BulkEditRecoveryService } = mods;

  const calls = [];
  const service = new BulkEditRecoveryService({
    db: {
      editHistory: {
        findFirst: async () => ({
          id: "h1",
          shop: "s.myshopify.com",
          executionIdentity: "exec-1",
          executionState: "VERIFYING",
          batch: {},
        }),
      },
    },
    acquireOperationLease: async () => ({ acquired: true }),
    releaseOperationLease: async () => {
      calls.push("releaseLease");
    },
    guardedEditHistoryUpdate: async () => {
      calls.push("casUpdate");
      return true;
    },
    enqueueVerification: async (payload) => {
      calls.push(`enqueueVerify:${payload.historyId}:${payload.shop}`);
    },
  });

  const result = await service.recoverStuckState({
    shop: "s.myshopify.com",
    historyId: "h1",
    mode: "verify",
  });

  assert.equal(result.recovered, true);
  assert.equal(result.mode, "verify");
  assert.ok(calls.includes("casUpdate"));
  assert.ok(calls.includes("enqueueVerify:h1:s.myshopify.com"));
  assert.ok(calls.includes("releaseLease"));
});

test("recovery service ingest mode uses lease + CAS + ingest enqueue", async (t) => {
  const mods = await loadRuntimeOrSkip(t);
  if (!mods) return;
  const { BulkEditRecoveryService } = mods;

  const calls = [];
  const service = new BulkEditRecoveryService({
    db: {
      editHistory: {
        findFirst: async () => ({
          id: "h2",
          shop: "s.myshopify.com",
          executionIdentity: "exec-2",
          executionState: "INGESTING_RESULTS",
          bulkOperationId: "gid://shopify/BulkOperation/22",
          batch: {},
        }),
      },
    },
    acquireOperationLease: async () => ({ acquired: true }),
    releaseOperationLease: async () => {
      calls.push("releaseLease");
    },
    guardedEditHistoryUpdate: async () => {
      calls.push("casUpdate");
      return true;
    },
    enqueueResultIngest: async (payload) => {
      calls.push(`enqueueIngest:${payload.bulkOperationId}`);
    },
  });

  const result = await service.recoverStuckState({
    shop: "s.myshopify.com",
    historyId: "h2",
    mode: "ingest",
  });

  assert.equal(result.recovered, true);
  assert.equal(result.mode, "ingest");
  assert.ok(calls.includes("casUpdate"));
  assert.ok(calls.includes("enqueueIngest:gid://shopify/BulkOperation/22"));
  assert.ok(calls.includes("releaseLease"));
});

test("recovery service rejects lease conflicts", async (t) => {
  const mods = await loadRuntimeOrSkip(t);
  if (!mods) return;
  const { BulkEditRecoveryService } = mods;

  const service = new BulkEditRecoveryService({
    acquireOperationLease: async () => ({ acquired: false }),
    releaseOperationLease: async () => {},
  });

  await assert.rejects(
    service.recoverStuckState({
      shop: "s.myshopify.com",
      historyId: "h3",
      mode: "auto",
    }),
    /BULK_EDIT_RECOVERY_LEASE_CONFLICT/,
  );
});

test("admin controller recover endpoint input + service integration", async (t) => {
  const mods = await loadRuntimeOrSkip(t);
  if (!mods) return;
  const {
    recoverStuckBulkEditOperation,
    __setBulkEditRecoveryServiceFactory,
  } = mods;

  const reqBad = { params: { id: "h9" }, body: {} };
  const resBad = createRes();
  await recoverStuckBulkEditOperation(reqBad, resBad);
  assert.equal(resBad.statusCode, 400);

  __setBulkEditRecoveryServiceFactory(() => ({
    recoverStuckState: async ({ shop, historyId, mode }) => ({
      recovered: true,
      shop,
      historyId,
      mode,
    }),
  }));
  const req = {
    params: { id: "h10" },
    body: { shop: "s.myshopify.com", mode: "verify", reason: "manual recovery after stalled verify" },
  };
  const res = createRes();
  await recoverStuckBulkEditOperation(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.success, true);
  assert.equal(res.body?.data?.recovered, true);
});
