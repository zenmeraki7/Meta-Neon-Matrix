import test from "node:test";
import assert from "node:assert/strict";
import {
  assertImmutableEditCommandIntegrity,
  buildImmutableEditCommand,
} from "./services/bulkEdit/immutableEditCommand.js";

test("immutable edit command signs full payload and rejects field tampering", () => {
  const command = buildImmutableEditCommand({
    shop: "shop-1",
    actorUserId: "user-1",
    edit: [{ field: "title", editOption: "set", value: "New title" }],
    targetSnapshotSetId: "EDIT_HISTORY:1",
    commandId: "command-1",
    createdAt: "2026-06-05T00:00:00.000Z",
  });

  assert.equal(command.schemaVersion, "1.1.0");
  assert.equal(command.signatureAlgorithm, "HMAC-SHA256");
  assert.equal(command.idempotencyKey, "shop-1:BULK_PRODUCT_EDIT:command-1");
  assert.doesNotThrow(() => assertImmutableEditCommandIntegrity(command));

  assert.throws(
    () => assertImmutableEditCommandIntegrity({
      ...command,
      createdAt: "2026-06-06T00:00:00.000Z",
    }),
    /IMMUTABLE_EDIT_COMMAND_TAMPERED/,
  );
  assert.throws(
    () => assertImmutableEditCommandIntegrity({
      ...command,
      edit: [{ field: "title", editOption: "set", value: "Other title" }],
    }),
    /IMMUTABLE_EDIT_COMMAND_TAMPERED/,
  );
});

test("immutable edit command requires JSON edit intent and target snapshot", () => {
  assert.throws(
    () => buildImmutableEditCommand({
      shop: "shop-1",
      edit: {},
      targetSnapshotSetId: "EDIT_HISTORY:1",
    }),
    /IMMUTABLE_EDIT_COMMAND_EDIT_REQUIRED/,
  );
  assert.throws(
    () => buildImmutableEditCommand({
      shop: "shop-1",
      edit: { field: undefined },
      targetSnapshotSetId: "EDIT_HISTORY:1",
    }),
    /NON_JSON_VALUE/,
  );
  assert.throws(
    () => buildImmutableEditCommand({
      shop: "shop-1",
      edit: [{ field: "title" }],
    }),
    /IMMUTABLE_EDIT_COMMAND_TARGET_SNAPSHOT_REQUIRED/,
  );
});
