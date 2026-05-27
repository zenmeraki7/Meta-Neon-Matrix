import { prisma } from "../../../config/database.js";

import {
  RULE_STATUS,
  PAUSE_POLICY,
  DELETE_POLICY,
  RUN_STATUS,
  OPERATION_STATUS,
  OPERATION_TYPE,
} from "../automaticProductRuleConstants.js";

import { publicError } from "../automaticProductRuleErrors.js";

import {
  actorRef,
  assertActor,
  assertAutomaticRuleQuota,
  assertEntitlementAllowed,
  assertMirrorSafeForTargeting,
  assertNoActiveRunForConfigMutation,
  assertResumeQuota,
  assertRuleId,
  assertShop,
  assertValidStateTransition,
  findRuleByShopAndIdOrThrow,
} from "../automaticProductRuleGuards.js";

import {
  buildUpdateDataFromPatch,
  createAuditEvent,
  hasConfigMutation,
  normalizeRuleCreateData,
} from "../automaticProductRulePersistence.js";

function assertDangerousActiveRuleIsConfirmed(command) {
  if (command.initialStatus !== RULE_STATUS.ACTIVE) {
    return;
  }

  if (command.safetyConfirmation?.confirmed === true) {
    return;
  }

  throw publicError(
    "PREVIEW_OR_CONFIRMATION_REQUIRED",
    400,
    "Automatic rules cannot be activated without safety confirmation.",
  );
}

async function cancelQueuedRunsForRule({ tx, shop, ruleId, actor, reason }) {
  const now = new Date();

  await tx.automaticProductRuleRun.updateMany({
    where: {
      shop,
      automaticProductRuleId: ruleId,
      status: {
        in: [RUN_STATUS.TARGET_FREEZE_QUEUED],
      },
    },
    data: {
      status: RUN_STATUS.CANCELLED,
      cancelledAt: now,
      cancelledBy: actorRef(actor),
      cancelReason: reason,
      updatedAt: now,
    },
  });

  if (!tx.operation) {
    return;
  }

  await tx.operation.updateMany({
    where: {
      shop,
      type: OPERATION_TYPE.AUTOMATIC_PRODUCT_RULE_RUN,
      status: OPERATION_STATUS.TARGET_FREEZE_QUEUED,
      automaticProductRuleId: ruleId,
    },
    data: {
      status: OPERATION_STATUS.CANCELLED,
      cancelledAt: now,
      cancelledBy: actorRef(actor),
      cancelReason: reason,
      updatedAt: now,
    },
  });
}

function assertDeleteConfirmationIfActiveRule(rule, deleteCommand = {}) {
  const status = rule?.status;
  if (status !== RULE_STATUS.ACTIVE) {
    return;
  }

  const confirmation = typeof deleteCommand.confirmation === "string"
    ? deleteCommand.confirmation.trim()
    : null;

  const confirmedByPhrase = confirmation === "DELETE AUTOMATIC RULE";
  const confirmedByFlag =
    deleteCommand.confirmationAccepted === true &&
    Object.values(DELETE_POLICY).includes(deleteCommand.deletePolicy);

  if (!confirmedByPhrase && !confirmedByFlag) {
    throw publicError(
      "CONFIRMATION_REQUIRED",
      400,
      "Confirmation is required before deleting an active automatic rule.",
    );
  }
}

export async function createAutomaticProductRule({ shop, actor, command, entitlement }) {
  const safeShop = assertShop(shop);
  const safeActor = assertActor(actor, safeShop);
  const safeEntitlement = assertEntitlementAllowed(entitlement);

  if (!command || typeof command !== "object") {
    throw publicError("INVALID_CREATE_RULE_COMMAND", 400, "Create automatic rule command is required.");
  }

  assertDangerousActiveRuleIsConfirmed(command);

  return prisma.$transaction(async (tx) => {
    await assertAutomaticRuleQuota({
      tx,
      shop: safeShop,
      entitlement: safeEntitlement,
    });

    const rule = await tx.automaticProductRule.create({
      data: normalizeRuleCreateData({
        shop: safeShop,
        actor: safeActor,
        command,
      }),
    });

    await createAuditEvent({
      tx,
      shop: safeShop,
      actor: safeActor,
      action: "AUTOMATIC_RULE_CREATED",
      resourceType: "AUTOMATIC_PRODUCT_RULE",
      resourceId: rule.id,
      metadata: {
        status: rule.status,
        revision: rule.revision,
        configFingerprint: rule.configFingerprint,
      },
    });

    return rule;
  });
}

export async function updateAutomaticProductRule({
  shop,
  actor,
  automaticProductRuleId,
  command,
  entitlement,
}) {
  const safeShop = assertShop(shop);
  const safeActor = assertActor(actor, safeShop);
  const safeRuleId = assertRuleId(automaticProductRuleId);

  assertEntitlementAllowed(entitlement);

  if (!command || typeof command !== "object") {
    throw publicError("INVALID_UPDATE_RULE_COMMAND", 400, "Update automatic rule command is required.");
  }

  if (!Number.isInteger(command.expectedRevision) || command.expectedRevision < 1) {
    throw publicError("EXPECTED_RULE_REVISION_REQUIRED", 400, "Expected rule revision is required.");
  }

  return prisma.$transaction(async (tx) => {
    const existingRule = await findRuleByShopAndIdOrThrow({
      tx,
      shop: safeShop,
      automaticProductRuleId: safeRuleId,
    });

    if (existingRule.revision !== command.expectedRevision) {
      throw publicError("RULE_REVISION_CONFLICT", 409, "Automatic rule has changed. Refresh and try again.", {
        currentRevision: existingRule.revision,
        expectedRevision: command.expectedRevision,
      });
    }

    if (hasConfigMutation(command)) {
      await assertNoActiveRunForConfigMutation({
        tx,
        shop: safeShop,
        ruleId: safeRuleId,
      });
    }

    if (command.status !== undefined && command.status !== existingRule.status) {
      assertValidStateTransition({
        from: existingRule.status,
        to: command.status,
      });
    }

    const updateResult = await tx.automaticProductRule.updateMany({
      where: {
        shop: safeShop,
        id: safeRuleId,
        deletedAt: null,
        revision: command.expectedRevision,
      },
      data: buildUpdateDataFromPatch({
        existingRule,
        patchCommand: command,
        actor: safeActor,
      }),
    });

    if (updateResult.count !== 1) {
      throw publicError("RULE_REVISION_CONFLICT", 409, "Automatic rule has changed. Refresh and try again.");
    }

    const updatedRule = await findRuleByShopAndIdOrThrow({
      tx,
      shop: safeShop,
      automaticProductRuleId: safeRuleId,
    });

    await createAuditEvent({
      tx,
      shop: safeShop,
      actor: safeActor,
      action: "AUTOMATIC_RULE_UPDATED",
      resourceType: "AUTOMATIC_PRODUCT_RULE",
      resourceId: safeRuleId,
      metadata: {
        previousRevision: existingRule.revision,
        revision: updatedRule.revision,
        configFingerprint: updatedRule.configFingerprint,
      },
    });

    return updatedRule;
  });
}

export async function pauseAutomaticProductRule({
  shop,
  actor,
  automaticProductRuleId,
  pausePolicy = PAUSE_POLICY.FUTURE_ONLY,
}) {
  const safeShop = assertShop(shop);
  const safeActor = assertActor(actor, safeShop);
  const safeRuleId = assertRuleId(automaticProductRuleId);

  if (!Object.values(PAUSE_POLICY).includes(pausePolicy)) {
    throw publicError("INVALID_PAUSE_POLICY", 400, "Invalid pause policy.");
  }

  return prisma.$transaction(async (tx) => {
    const rule = await findRuleByShopAndIdOrThrow({
      tx,
      shop: safeShop,
      automaticProductRuleId: safeRuleId,
    });

    if (rule.status === RULE_STATUS.PAUSED) {
      return rule;
    }

    assertValidStateTransition({
      from: rule.status,
      to: RULE_STATUS.PAUSED,
    });

    const now = new Date();

    const updateResult = await tx.automaticProductRule.updateMany({
      where: {
        shop: safeShop,
        id: safeRuleId,
        deletedAt: null,
        revision: rule.revision,
      },
      data: {
        status: RULE_STATUS.PAUSED,
        pausedAt: now,
        pausedBy: actorRef(safeActor),
        schedulerDisabledAt: now,
        updatedAt: now,
        updatedBy: actorRef(safeActor),
        revision: {
          increment: 1,
        },
      },
    });

    if (updateResult.count !== 1) {
      throw publicError("RULE_REVISION_CONFLICT", 409, "Automatic rule changed while pausing.");
    }

    if (pausePolicy === PAUSE_POLICY.CANCEL_QUEUED) {
      await cancelQueuedRunsForRule({
        tx,
        shop: safeShop,
        ruleId: safeRuleId,
        actor: safeActor,
        reason: "RULE_PAUSED",
      });
    }

    const pausedRule = await findRuleByShopAndIdOrThrow({
      tx,
      shop: safeShop,
      automaticProductRuleId: safeRuleId,
    });

    await createAuditEvent({
      tx,
      shop: safeShop,
      actor: safeActor,
      action: "AUTOMATIC_RULE_PAUSED",
      resourceType: "AUTOMATIC_PRODUCT_RULE",
      resourceId: safeRuleId,
      metadata: {
        previousStatus: rule.status,
        pausePolicy,
        revision: pausedRule.revision,
      },
    });

    return pausedRule;
  });
}

export async function resumeAutomaticProductRule({ shop, actor, automaticProductRuleId, entitlement }) {
  const safeShop = assertShop(shop);
  const safeActor = assertActor(actor, safeShop);
  const safeRuleId = assertRuleId(automaticProductRuleId);
  const safeEntitlement = assertEntitlementAllowed(entitlement);

  return prisma.$transaction(async (tx) => {
    const rule = await findRuleByShopAndIdOrThrow({
      tx,
      shop: safeShop,
      automaticProductRuleId: safeRuleId,
    });

    if (rule.status === RULE_STATUS.ACTIVE) {
      return rule;
    }

    assertValidStateTransition({
      from: rule.status,
      to: RULE_STATUS.ACTIVE,
    });

    await assertResumeQuota({
      tx,
      shop: safeShop,
      entitlement: safeEntitlement,
    });

    await assertMirrorSafeForTargeting({
      tx,
      shop: safeShop,
    });

    const now = new Date();

    const updateResult = await tx.automaticProductRule.updateMany({
      where: {
        shop: safeShop,
        id: safeRuleId,
        deletedAt: null,
        revision: rule.revision,
      },
      data: {
        status: RULE_STATUS.ACTIVE,
        resumedAt: now,
        resumedBy: actorRef(safeActor),
        schedulerDisabledAt: null,
        updatedAt: now,
        updatedBy: actorRef(safeActor),
        revision: {
          increment: 1,
        },
      },
    });

    if (updateResult.count !== 1) {
      throw publicError("RULE_REVISION_CONFLICT", 409, "Automatic rule changed while resuming.");
    }

    const resumedRule = await findRuleByShopAndIdOrThrow({
      tx,
      shop: safeShop,
      automaticProductRuleId: safeRuleId,
    });

    await createAuditEvent({
      tx,
      shop: safeShop,
      actor: safeActor,
      action: "AUTOMATIC_RULE_RESUMED",
      resourceType: "AUTOMATIC_PRODUCT_RULE",
      resourceId: safeRuleId,
      metadata: {
        previousStatus: rule.status,
        revision: resumedRule.revision,
      },
    });

    return resumedRule;
  });
}

export async function softDeleteAutomaticProductRule({
  shop,
  actor,
  automaticProductRuleId,
  deleteCommand = {},
}) {
  const safeShop = assertShop(shop);
  const safeActor = assertActor(actor, safeShop);
  const safeRuleId = assertRuleId(automaticProductRuleId);
  const safeDeletePolicy = deleteCommand?.deletePolicy || DELETE_POLICY.BLOCK_FUTURE_RUNS;

  if (!Object.values(DELETE_POLICY).includes(safeDeletePolicy)) {
    throw publicError("INVALID_DELETE_POLICY", 400, "Invalid delete policy.");
  }

  return prisma.$transaction(async (tx) => {
    const rule = await findRuleByShopAndIdOrThrow({
      tx,
      shop: safeShop,
      automaticProductRuleId: safeRuleId,
    });

    if (rule.status === RULE_STATUS.DELETED) {
      return rule;
    }

    assertDeleteConfirmationIfActiveRule(rule, {
      ...deleteCommand,
      deletePolicy: safeDeletePolicy,
    });

    assertValidStateTransition({
      from: rule.status,
      to: RULE_STATUS.DELETED,
    });

    const now = new Date();

    const updateResult = await tx.automaticProductRule.updateMany({
      where: {
        shop: safeShop,
        id: safeRuleId,
        deletedAt: null,
        revision: rule.revision,
      },
      data: {
        status: RULE_STATUS.DELETED,
        deletedAt: now,
        deletedBy: actorRef(safeActor),
        schedulerDisabledAt: now,
        updatedAt: now,
        updatedBy: actorRef(safeActor),
        revision: {
          increment: 1,
        },
      },
    });

    if (updateResult.count !== 1) {
      throw publicError("RULE_REVISION_CONFLICT", 409, "Automatic rule changed while deleting.");
    }

    if (safeDeletePolicy === DELETE_POLICY.CANCEL_QUEUED) {
      await cancelQueuedRunsForRule({
        tx,
        shop: safeShop,
        ruleId: safeRuleId,
        actor: safeActor,
        reason: "RULE_DELETED",
      });
    }

    const deletedRule = await tx.automaticProductRule.findFirst({
      where: {
        shop: safeShop,
        id: safeRuleId,
      },
    });

    await createAuditEvent({
      tx,
      shop: safeShop,
      actor: safeActor,
      action: "AUTOMATIC_RULE_DELETED",
      resourceType: "AUTOMATIC_PRODUCT_RULE",
      resourceId: safeRuleId,
      metadata: {
        previousStatus: rule.status,
        deletePolicy: safeDeletePolicy,
        revision: deletedRule?.revision ?? null,
      },
    });

    return deletedRule;
  });
}
