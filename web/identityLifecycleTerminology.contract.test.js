import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  requireAggregateIdentity,
  requireEntityIdentity,
  requireOwnerIdentity,
  requireResourceIdentity,
  requireSourceIdentity,
} from "./utils/polymorphicIdentity.js";

test("polymorphic identities retain their domain-specific pair", () => {
  assert.deepEqual(
    requireAggregateIdentity(
      { aggregateType: "EDIT_HISTORY", aggregateId: "edit-1" },
      ["EDIT_HISTORY"],
    ),
    { aggregateType: "EDIT_HISTORY", aggregateId: "edit-1" },
  );
  assert.deepEqual(requireOwnerIdentity({ ownerType: "PRODUCT", ownerId: "p1" }, ["PRODUCT"]), {
    ownerType: "PRODUCT",
    ownerId: "p1",
  });
  assert.deepEqual(requireEntityIdentity({ entityType: "VARIANT", entityId: "v1" }, ["VARIANT"]), {
    entityType: "VARIANT",
    entityId: "v1",
  });
  assert.deepEqual(requireResourceIdentity({ resourceType: "LEASE", resourceId: "r1" }, ["LEASE"]), {
    resourceType: "LEASE",
    resourceId: "r1",
  });
  assert.deepEqual(requireSourceIdentity({ sourceType: "RULE", sourceId: "s1" }, ["RULE"]), {
    sourceType: "RULE",
    sourceId: "s1",
  });
});

test("polymorphic identities reject cross-domain type reuse", () => {
  assert.throws(
    () => requireOwnerIdentity({ ownerType: "EDIT_HISTORY", ownerId: "1" }, ["PRODUCT", "VARIANT"]),
    /INVALID_OWNERTYPE/,
  );
  assert.throws(
    () => requireEntityIdentity({ entityType: "PRODUCT", entityId: "" }, ["PRODUCT"]),
    /INVALID_ENTITYID/,
  );
});

test("persisted lifecycle, type, and scope names are qualified", () => {
  const schema = fs.readFileSync(path.join(process.cwd(), "web/prisma/schema.prisma"), "utf8");
  assert.match(schema, /outcomeStatus\s+String\s+@default\("pending"\) @map\("status"\)/);
  assert.match(schema, /executionState\s+String\s+@default\("queued"\) @map\("state"\)/);
  assert.match(schema, /metafieldType\s+String\? @map\("type"\)/);
  assert.match(schema, /editType\s+String\?.*@map\("type"\)/);
  assert.match(schema, /exportType\s+String.*@map\("type"\)/);
  assert.match(schema, /oauthScopes\s+String\?.*@map\("scope"\)/);
  assert.match(schema, /changeScope\s+String @map\("scope"\)/);
  assert.match(schema, /legacyUser\s+String\?.*@map\("user"\)/);
  assert.match(schema, /requestedAt\s+DateTime.*@map\("editTime"\)/);
  assert.match(schema, /actorDisplayName\s+String\?.*@map\("actorName"\)/);
  assert.match(schema, /createdByActorId\s+String\?.*@map\("createdBy"\)/);
  assert.match(schema, /cancelledByActorId\s+String\?.*@map\("cancelledBy"\)/);
  assert.match(schema, /failureCode\s+String\?.*@map\("errorCode"\)/);
  assert.match(schema, /failureMessage\s+String\?.*@map\("errorMessage"\)/);
  assert.match(schema, /affectedFieldKeys\s+Json\?.*@map\("affectedFields"\)/);
  assert.match(schema, /selectedFieldKeys\s+String\[\].*@map\("fields"\)/);
  assert.match(schema, /rawFilterInput\s+Json.*@map\("filterParams"\)/);
  assert.match(schema, /legacyQueryFilter\s+String.*@map\("queryFilter"\)/);
  assert.match(schema, /targetResolutionMode\s+String\?.*@map\("targetMode"\)/);
  assert.match(schema, /targetFreezeMode\s+String\?.*@map\("targetingMode"\)/);
  assert.match(schema, /targetResourceType\s+AutomaticProductRuleScopeType.*@map\("scopeType"\)/);
  assert.match(schema, /beforeValues\s+Json @map\("before"\)/);
  assert.match(schema, /undoMutation\s+Json\? @map\("undoPayload"\)/);
  assert.match(schema, /generatedFilename\s+String.*@map\("filename"\)/);
  assert.match(schema, /downloadUrl\s+String\?.*@map\("fileUrl"\)/);
  assert.doesNotMatch(schema, /legacyIsDeleted/);
  assert.match(schema, /installationStatus\s+StoreInstallationStatus/);
  assert.doesNotMatch(schema, /legacyIsUninstalled/);
});

test("integrity, mirror, source, and queue fields expose qualified logical names", () => {
  const schema = fs.readFileSync(path.join(process.cwd(), "web/prisma/schema.prisma"), "utf8");
  assert.match(schema, /ruleConfigHash\s+String\?.*@map\("configFingerprint"\)/);
  assert.match(schema, /targetDefinitionHash\s+String @map\("targetingFingerprint"\)/);
  assert.match(schema, /normalizedFilterHash\s+String\?.*@map\("filterHash"\)/);
  assert.match(schema, /targetRowHash\s+String @map\("targetFingerprint"\)/);
  assert.match(schema, /targetSetHash\s+String\? @map\("checksum"\)/);
  assert.match(schema, /tombstoneMutationSequence\s+BigInt @map\("mutationSequence"\)/);
  assert.match(schema, /replayFinalizedThroughSequence\s+BigInt\? @map\("finalizedSequence"\)/);
  assert.match(schema, /currentProductMirrorBatchId\s+String\? @map\("activeMirrorBatchId"\)/);
  assert.match(schema, /targetProductMirrorBatchId\s+String\?.*@map\("targetMirrorBatchId"\)/);
  assert.match(schema, /sourceEntityUpdatedAt\s+DateTime\? @map\("sourceUpdatedAt"\)/);
  assert.match(schema, /sourceEventOccurredAt\s+DateTime\? @map\("sourceEventAt"\)/);
  assert.match(schema, /queueRoutingKey\s+String @map\("queueKey"\)/);
  assert.match(schema, /queueJobName\s+String @map\("jobName"\)/);
  assert.match(schema, /availableAt\s+DateTime.*@map\("runAt"\)/);
});

test("dynamic automatic rules fail closed without a normalized AST", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "web/services/automaticProductRule/commands/runAutomaticProductRuleNowCommand.js"),
    "utf8",
  );
  assert.match(source, /rule\.targetResolutionMode === "DYNAMIC_FILTER"/);
  assert.match(source, /AUTOMATIC_RULE_NORMALIZED_FILTER_REQUIRED/);
  assert.match(source, /filterAst: rule\.normalizedFilterAst \?\? null/);
});

test("deletedAt and installationStatus are authoritative lifecycle fields", () => {
  const deleteCommand = fs.readFileSync(
    path.join(process.cwd(), "web/services/automaticProductRule/commands/mutateAutomaticProductRuleCommand.js"),
    "utf8",
  );
  const ruleRepository = fs.readFileSync(
    path.join(process.cwd(), "web/repositories/automaticProductRuleRepository.js"),
    "utf8",
  );
  const installWorker = fs.readFileSync(
    path.join(process.cwd(), "web/Jobs/Workers/appInstallationWorker.js"),
    "utf8",
  );
  assert.match(deleteCommand, /deletedAt: now/);
  assert.doesNotMatch(deleteCommand, /status:\s*RULE_STATUS\.DELETED/);
  assert.match(ruleRepository, /deletedAt: null/);
  assert.doesNotMatch(ruleRepository, /isDeleted: false/);
  assert.match(installWorker, /installationStatus: "INSTALLED"/);
  assert.doesNotMatch(installWorker, /isUninstalled: false/);
});

test("export queue and command boundaries use selectedFieldKeys", () => {
  const service = fs.readFileSync(
    path.join(process.cwd(), "web/services/productService/productExportService.js"),
    "utf8",
  );
  const worker = fs.readFileSync(
    path.join(process.cwd(), "web/Jobs/Workers/bulkExportWorker.js"),
    "utf8",
  );
  assert.doesNotMatch(service, /fields:\s*normalizedFields/);
  assert.match(service, /selectedFieldKeys:\s*normalizedFields/);
  assert.match(worker, /const \{ exportJobId, shop, selectedFieldKeys/);
});

test("outbox dispatch validates aggregate type before crossing the queue boundary", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "web/workers/outboxDispatcherWorker.js"),
    "utf8",
  );
  assert.match(source, /requireAggregateIdentity\(event, \["AUTOMATIC_PRODUCT_RULE_RUN"\]\)/);
  assert.match(source, /requireAggregateIdentity\(event, \["UNDO_EXECUTION"\]\)/);
});
