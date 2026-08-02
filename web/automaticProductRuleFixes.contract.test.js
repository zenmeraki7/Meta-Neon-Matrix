import test from "node:test";
import assert from "node:assert/strict";

import {
  createAutomaticProductRuleController,
  updateAutomaticProductRuleController,
} from "./controllers/automaticProductRuleController.js";

import {
  normalizeCreateAutomaticProductRuleBody,
  normalizeUpdateAutomaticProductRuleBody,
} from "./controllers/automaticProductRuleRequestNormalizers.js";

import {
  validateCreateAutomaticProductRuleCommand,
} from "./controllers/automaticProductRuleCommandNormalizer.js";

import {
  normalizeRuleCreateData,
  buildUpdateDataFromPatch,
  computeRuleConfigHashFromRuleLike,
} from "./services/automaticProductRule/automaticProductRulePersistence.js";

import { automaticProductRuleCommandService } from "./services/automaticProductRuleCommandService.js";
import { executeRecurringEditRun } from "./services/recurringEditExecutionService.js";
import { recurringEditRunRepository } from "./repositories/recurringEditRunRepository.js";
import { recurringEditRepository } from "./repositories/recurringEditRepository.js";

function mockResponse() {
  const res = {
    statusCode: 200,
    body: null,
    locals: {
      shopify: {
        session: {
          shop: "test-shop.myshopify.com",
          id: "session-123",
        },
      },
      entitlement: {
        allowed: true,
        limits: {
          maxAutomaticRules: 10,
        },
      },
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
  };
  return res;
}

// Issue 1: Envelope Unwrapping & Required Schema Mapping
test("Issue 1: Controller unwraps envelope so service receives flat command without nested command.command", async () => {
  let capturedArgs = null;
  const originalCreateRule = automaticProductRuleCommandService.createRule;

  try {
    automaticProductRuleCommandService.createRule = async (args) => {
      capturedArgs = args;
      return {
        id: "rule_1234567890",
        shop: args.shop,
        title: args.command.title,
        status: "ACTIVE",
        revision: 1,
        commandVersion: 1,
        triggerType: "EVENT",
        targetResourceType: "PRODUCT",
        conditions: [],
        actions: [{ field: "title", value: "New Title" }],
        applyMode: "BULK_EDIT",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    };

    const req = {
      body: {
        title: "Event Rule",
        filterAst: { field: "vendor", operator: "EQUALS", value: "Nike" },
        actions: [{ field: "title", value: "New Title" }],
        triggerType: "EVENT",
        targetResourceType: "PRODUCT",
        applyMode: "BULK_EDIT",
      },
    };
    const res = mockResponse();

    await createAutomaticProductRuleController(req, res);

    assert.equal(res.statusCode, 201);
    assert.ok(capturedArgs, "createRule service should have been called");
    assert.equal(capturedArgs.command.command, undefined, "Command service must NOT receive nested command.command");
    assert.equal(capturedArgs.command.title, "Event Rule");
    assert.equal(capturedArgs.command.triggerType, "EVENT");
    assert.equal(capturedArgs.command.commandVersion, 1);
  } finally {
    automaticProductRuleCommandService.createRule = originalCreateRule;
  }
});

test("Issue 1: normalizeRuleCreateData maps every required current-schema field", () => {
  const command = {
    title: "Scheduled Rule",
    triggerType: "SCHEDULED",
    scheduleType: "DAILY",
    scheduleConfig: { frequency: "DAILY", timezone: "America/New_York", merchantLocalTime: "09:00", startsAtUtc: "2026-08-01T13:00:00Z" },
    timezone: "America/New_York",
    conditions: [{ field: "price", operator: "GREATER_THAN", value: "100" }],
    actions: [{ field: "tag", value: "Premium" }],
    targetResourceType: "PRODUCT",
    applyMode: "BULK_EDIT",
    commandVersion: 1,
    targetResolutionMode: "DYNAMIC_FILTER",
  };

  const actor = { actorType: "SHOPIFY_USER", shop: "test-shop.myshopify.com" };
  const data = normalizeRuleCreateData({ shop: "test-shop.myshopify.com", actor, command });

  assert.equal(data.title, "Scheduled Rule");
  assert.equal(data.triggerType, "SCHEDULED");
  assert.equal(data.scheduleType, "DAILY");
  assert.deepEqual(data.scheduleConfig, command.scheduleConfig);
  assert.deepEqual(data.conditions, command.conditions);
  assert.deepEqual(data.actions, command.actions);
  assert.equal(data.targetResourceType, "PRODUCT");
  assert.equal(data.applyMode, "BULK_EDIT");
  assert.ok(data.ruleConfigHash, "ruleConfigHash must be present");
});

// Issue 2: Isolated Update Request Normalization
test("Issue 2: normalizeUpdateAutomaticProductRuleBody permits expectedRevision and returns flat patch command", () => {
  const body = {
    expectedRevision: 3,
    title: "Updated Title",
    actions: [{ field: "status", value: "ACTIVE" }],
  };

  const result = normalizeUpdateAutomaticProductRuleBody(body);

  assert.equal(result.expectedRevision, 3);
  assert.equal(result.title, "Updated Title");
  assert.deepEqual(result.actions, [{ field: "status", value: "ACTIVE" }]);
  assert.equal(result.command, undefined, "Update normalizer should return flat patch, not nested command");
});

test("Issue 2: Missing or invalid expectedRevision returns 400 with expected revision error", async () => {
  const req = {
    params: { id: "rule_12345678" },
    body: {
      title: "Updated Title",
    },
  };
  const res = mockResponse();

  await updateAutomaticProductRuleController(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "VALIDATION_FAILED");
});

test("Issue 2: Stale expectedRevision returns 409 conflict when calling updateRule", async () => {
  const originalUpdateRule = automaticProductRuleCommandService.updateRule;

  try {
    automaticProductRuleCommandService.updateRule = async () => {
      const err = new Error("Automatic rule has changed.");
      err.code = "RULE_REVISION_CONFLICT";
      err.statusCode = 409;
      throw err;
    };

    const req = {
      params: { id: "rule_12345678" },
      body: {
        expectedRevision: 1,
        title: "Updated Title",
      },
    };
    const res = mockResponse();

    await updateAutomaticProductRuleController(req, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "CONFLICT");
  } finally {
    automaticProductRuleCommandService.updateRule = originalUpdateRule;
  }
});

// Issue 3: Modern Persistence Update Mapping & No-op Protection
test("Issue 3: buildUpdateDataFromPatch maps modern API fields and updates config hash", () => {
  const existingRule = {
    id: "rule_1",
    shop: "test-shop.myshopify.com",
    title: "Old Title",
    revision: 1,
    commandVersion: 1,
    triggerType: "EVENT",
    targetResourceType: "PRODUCT",
    applyMode: "BULK_EDIT",
    conditions: [],
    actions: [{ field: "title", value: "Old" }],
  };

  const patchCommand = {
    title: "New Title",
    actions: [{ field: "title", value: "New" }],
    triggerType: "SCHEDULED",
  };

  const actor = { actorType: "SHOPIFY_USER", shop: "test-shop.myshopify.com" };
  const updateData = buildUpdateDataFromPatch({ existingRule, patchCommand, actor });

  assert.equal(updateData.title, "New Title");
  assert.deepEqual(updateData.actions, [{ field: "title", value: "New" }]);
  assert.equal(updateData.triggerType, "SCHEDULED");
  assert.deepEqual(updateData.revision, { increment: 1 });
  assert.ok(updateData.ruleConfigHash);
});

test("Issue 3: No-op / unknown field patch does not increment revision", () => {
  const existingRule = {
    id: "rule_1",
    shop: "test-shop.myshopify.com",
    title: "Old Title",
    revision: 1,
    commandVersion: 1,
  };

  const patchCommand = {
    unknownField: "someValue",
  };

  const actor = { actorType: "SHOPIFY_USER", shop: "test-shop.myshopify.com" };
  const updateData = buildUpdateDataFromPatch({ existingRule, patchCommand, actor });

  assert.equal(updateData.revision, undefined, "Revision should NOT be incremented for no-op/unknown patch");
});

// Issue 4: Recurring Edit Compiler Version Guardrails
test("Issue 4: Active legacy recurring record with missing compiler version is paused and skipped", async () => {
  const origFindByIdWithEdit = recurringEditRunRepository.findByIdWithRecurringEdit;
  const origUpdateById = recurringEditRepository.updateByIdForShop;
  const origMarkSkipped = recurringEditRunRepository.markPendingSkipped;

  const recordedUpdates = [];
  let markSkippedCalled = false;

  try {
    recurringEditRunRepository.findByIdWithRecurringEdit = async () => ({
      id: "run_100",
      shop: "test-shop.myshopify.com",
      status: "PENDING",
      recurringEditId: "rec_100",
      recurringEdit: {
        id: "rec_100",
        shop: "test-shop.myshopify.com",
        status: "ACTIVE",
        targetingCompilerVersion: null, // missing created compiler version
        targetingSnapshotMeta: null,
      },
    });

    recurringEditRepository.updateByIdForShop = async ({ id, shop, data }) => {
      recordedUpdates.push(data);
      return { count: 1 };
    };

    recurringEditRunRepository.markPendingSkipped = async () => {
      markSkippedCalled = true;
      return { count: 1 };
    };

    const result = await executeRecurringEditRun("run_100", "test-shop.myshopify.com");

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "compiler_version_mismatch_requires_confirmation");
    const pausedUpdate = recordedUpdates.find((d) => d.status === "PAUSED");
    assert.ok(pausedUpdate, "Recurring edit must be updated to PAUSED");
    assert.equal(pausedUpdate.status, "PAUSED");
    assert.equal(pausedUpdate.nextRunAt, null);
    assert.equal(markSkippedCalled, true);
  } finally {
    recurringEditRunRepository.findByIdWithRecurringEdit = origFindByIdWithEdit;
    recurringEditRepository.updateByIdForShop = origUpdateById;
    recurringEditRunRepository.markPendingSkipped = origMarkSkipped;
  }
});

// Issue 5: Legacy editedField Normalization
test("Issue 5: Create rule with only editedField converts to canonical actions", () => {
  const body = {
    title: "Legacy EditedField Rule",
    filterAst: { field: "title", operator: "CONTAINS", value: "Shirt" },
    editedField: "title",
    triggerType: "EVENT",
  };

  const envelope = normalizeCreateAutomaticProductRuleBody(body);
  const validated = validateCreateAutomaticProductRuleCommand(envelope);

  assert.deepEqual(envelope.command.actions, [{ field: "title", locationId: null }]);
  assert.equal(envelope.command.editedField, undefined, "editedField must be discarded after conversion");
  assert.equal(validated.command.title, "Legacy EditedField Rule");
});

test("Issue 5: Create rule with editedField=inventory without locationId fails location validation", () => {
  const body = {
    title: "Inventory Rule",
    filterAst: { field: "title", operator: "CONTAINS", value: "Shirt" },
    editedField: "inventory",
    triggerType: "EVENT",
  };

  const envelope = normalizeCreateAutomaticProductRuleBody(body);

  assert.throws(
    () => validateCreateAutomaticProductRuleCommand(envelope),
    (err) => err.code === "AUTOMATIC_RULE_LOCATION_REQUIRED",
  );
});

test("Issue 5: Create rule with both actions and editedField is rejected as ambiguous", () => {
  const body = {
    title: "Ambiguous Rule",
    filterAst: { field: "title", operator: "CONTAINS", value: "Shirt" },
    actions: [{ field: "title", value: "New" }],
    editedField: "title",
    triggerType: "EVENT",
  };

  assert.throws(
    () => normalizeCreateAutomaticProductRuleBody(body),
    (err) => err.code === "AMBIGUOUS_ACTION_DEFINITION",
  );
});
