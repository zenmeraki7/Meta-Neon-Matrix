import test from "node:test";
import assert from "node:assert/strict";

test("crash after submit response reconciles on restart without second mutation submit", async (t) => {
  let ShopifyBulkMutationService;
  try {
    ({ ShopifyBulkMutationService } = await import("./services/bulkEdit/ShopifyBulkMutationService.js"));
  } catch (error) {
    const message = String(error?.message || error || "");
    if (
      message.includes("@google-cloud/translate")
      || message.includes("generated/prisma/index.js")
      || message.includes("Cannot find package")
      || message.includes("ERR_MODULE_NOT_FOUND")
    ) {
      t.skip(`Runtime harness skipped in minimal env: ${message}`);
      return;
    }
    throw error;
  }

  const historyId = "h1";
  const shop = "s.myshopify.com";
  const executionIdentity = "exec-1";
  const batchState = {};
  const state = {
    history: {
      id: historyId,
      shop,
      executionIdentity,
      cancelRequestedAt: null,
      batch: batchState,
    },
    submissions: [],
    txCalls: 0,
  };

  const db = {
    editHistory: {
      findFirst: async () => ({ ...state.history, batch: state.history.batch }),
      update: async ({ data }) => {
        if (data.batch) state.history.batch = data.batch;
        if (data.executionState) state.history.executionState = data.executionState;
        return { ...state.history };
      },
      updateMany: async ({ data }) => {
        if (data.batch) state.history.batch = data.batch;
        if (data.executionState) state.history.executionState = data.executionState;
        return { count: 1 };
      },
    },
    bulkSubmission: {
      findFirst: async () => state.submissions[0] || null,
      upsert: async ({ create }) => {
        const existing = state.submissions.find((s) => s.shopifyBulkOperationId === create.shopifyBulkOperationId);
        if (!existing) state.submissions.push({ ...create, submittedAt: create.submittedAt || new Date() });
        return existing || create;
      },
      create: async ({ data }) => {
        state.submissions.push({ ...data });
        return data;
      },
    },
    $transaction: async (callback) => {
      state.txCalls += 1;
      if (state.txCalls === 1) {
        throw new Error("SIMULATED_CRASH_AFTER_RESPONSE");
      }
      const tx = {
        bulkSubmission: {
          create: async ({ data }) => {
            state.submissions.push({ ...data });
            return data;
          },
        },
        editHistory: {
          updateMany: async ({ data }) => {
            if (data.batch) state.history.batch = data.batch;
            state.history.executionState = data.executionState || state.history.executionState;
            return { count: 1 };
          },
        },
      };
      return callback(tx);
    },
  };

  let mutationSubmitCalls = 0;
  const client = {
    query: async ({ data }) => {
      const queryText = String(data?.query || "");
      if (queryText.includes("CurrentBulkOperation")) {
        return { body: { data: { currentBulkOperation: null } } };
      }
      if (queryText.includes("stagedUploadsCreate")) {
        return {
          body: {
            data: {
              stagedUploadsCreate: {
                userErrors: [],
                stagedTargets: [{ url: "https://upload.example", resourceUrl: "res", parameters: [] }],
              },
            },
          },
        };
      }
      if (queryText.includes("bulkOperationRunMutation")) {
        mutationSubmitCalls += 1;
        return {
          body: {
            data: {
              bulkOperationRunMutation: {
                userErrors: [],
                bulkOperation: {
                  id: "gid://shopify/BulkOperation/123",
                  status: "CREATED",
                  type: "MUTATION",
                  createdAt: new Date().toISOString(),
                },
              },
            },
          },
        };
      }
      throw new Error(`unexpected query: ${queryText.slice(0, 60)}`);
    },
  };

  const service = new ShopifyBulkMutationService(
    { shop },
    client,
    {
      db,
      uploadToShopifyStagedTarget: async () => "staged/path.jsonl",
      upsertOperationStageProgress: async () => {},
      cacheSet: async () => {},
    },
  );

  await assert.rejects(
    service.submitProductSetBulkMutation({
      historyId,
      executionId: executionIdentity,
      formattedProducts: '{"input":1}\n',
      fields: ["title"],
      batchId: "b1",
      batchTargetCount: 1,
      hasMore: false,
    }),
    /SIMULATED_CRASH_AFTER_RESPONSE|SHOPIFY_SUBMISSION_FINALIZE_CONFLICT/,
  );

  assert.equal(mutationSubmitCalls, 1);
  assert.equal(
    state.history.batch?.shopifySubmissionIntent?.submissionStage,
    "SUBMIT_RESPONSE_RECEIVED",
  );
  assert.equal(
    state.history.batch?.shopifySubmissionIntent?.shopifyBulkOperationId,
    "gid://shopify/BulkOperation/123",
  );

  const resumed = await service.submitProductSetBulkMutation({
    historyId,
    executionId: executionIdentity,
    formattedProducts: '{"input":1}\n',
    fields: ["title"],
    batchId: "b1",
    batchTargetCount: 1,
    hasMore: false,
  });

  assert.equal(resumed.reconciled, true);
  assert.equal(resumed.pendingIntent, true);
  assert.equal(resumed.shopifyBulkOperationId, "gid://shopify/BulkOperation/123");
  assert.equal(mutationSubmitCalls, 1, "must not submit mutation twice");
  assert.ok(state.submissions.length >= 1, "reconcile must restore durable submission record");
});
