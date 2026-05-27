import { prisma } from "../../../config/database.js";
import { Prisma } from "../../../generated/prisma/index.js";

import {
  OPERATION_SOURCE,
  OPERATION_STATUS,
  OPERATION_TYPE,
  OUTBOX_STATUS,
  RUN_STATUS,
  TARGET_FREEZE_COMMAND_STATUS,
  TARGET_FREEZE_SOURCE_TYPE,
} from "../automaticProductRuleConstants.js";

import {
  assertActor,
  assertEntitlementAllowed,
  assertExpectedRuleRevision,
  assertIdempotencyKey,
  assertManualRunQuota,
  assertMirrorSafeForTargeting,
  assertNoActiveRun,
  assertRuleId,
  assertRuleRevision,
  assertRuleRunnable,
  assertShop,
  findRuleByShopAndIdOrThrow,
} from "../automaticProductRuleGuards.js";

import { createAuditEvent } from "../automaticProductRulePersistence.js";

async function getExistingRunByIdempotencyKey({ tx, shop, idempotencyKey }) {
  return tx.automaticProductRuleRun.findUnique({
    where: {
      shop_idempotencyKey: {
        shop,
        idempotencyKey,
      },
    },
  });
}

export async function runAutomaticProductRuleNow({
  shop,
  actor,
  automaticProductRuleId,
  idempotencyKey,
  entitlement,
  expectedRuleRevision,
}) {
  const safeShop = assertShop(shop);
  const safeActor = assertActor(actor, safeShop);
  const safeRuleId = assertRuleId(automaticProductRuleId);
  const safeIdempotencyKey = assertIdempotencyKey(idempotencyKey);
  const safeExpectedRuleRevision = assertExpectedRuleRevision(expectedRuleRevision);
  const safeEntitlement = assertEntitlementAllowed(entitlement);

  return prisma.$transaction(async (tx) => {
    const existingRun = await getExistingRunByIdempotencyKey({
      tx,
      shop: safeShop,
      idempotencyKey: safeIdempotencyKey,
    });

    if (existingRun) {
      return existingRun;
    }

    const rule = await findRuleByShopAndIdOrThrow({
      tx,
      shop: safeShop,
      automaticProductRuleId: safeRuleId,
    });

    assertRuleRunnable(rule);
    assertRuleRevision(rule, safeExpectedRuleRevision);

    await assertManualRunQuota({
      tx,
      shop: safeShop,
      ruleId: safeRuleId,
      entitlement: safeEntitlement,
    });

    const store = await assertMirrorSafeForTargeting({
      tx,
      shop: safeShop,
    });

    await assertNoActiveRun({
      tx,
      shop: safeShop,
      ruleId: safeRuleId,
    });

    const now = new Date();

    const operation = tx.operation
      ? await tx.operation.create({
        data: {
          shop: safeShop,
          type: OPERATION_TYPE.AUTOMATIC_PRODUCT_RULE_RUN,
          source: OPERATION_SOURCE.AUTOMATIC_RULE_RUN_NOW,
          status: OPERATION_STATUS.TARGET_FREEZE_QUEUED,
          actorJson: safeActor,
          idempotencyKey: safeIdempotencyKey,
          automaticProductRuleId: safeRuleId,
          ruleRevision: rule.revision,
          configFingerprint: rule.configFingerprint,
          metadataJson: {
            ruleId: rule.id,
            ruleRevision: rule.revision,
            configFingerprint: rule.configFingerprint,
            mirrorBatchId: store.activeMirrorBatchId,
          },
          createdAt: now,
          updatedAt: now,
        },
      })
      : null;

    let run;
    try {
      run = await tx.automaticProductRuleRun.create({
        data: {
          shop: safeShop,
          automaticProductRuleId: rule.id,
          operationId: operation?.id || null,
          source: OPERATION_SOURCE.AUTOMATIC_RULE_RUN_NOW,
          ruleRevision: rule.revision,
          configFingerprint: rule.configFingerprint,
          idempotencyKey: safeIdempotencyKey,
          status: RUN_STATUS.TARGET_FREEZE_QUEUED,
          requestedByJson: safeActor,
          mirrorBatchId: store.activeMirrorBatchId,
          createdAt: now,
          updatedAt: now,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const existingByUnique = await getExistingRunByIdempotencyKey({
          tx,
          shop: safeShop,
          idempotencyKey: safeIdempotencyKey,
        });
        if (existingByUnique) {
          return existingByUnique;
        }
      }
      throw error;
    }

    if (tx.targetFreezeCommand) {
      await tx.targetFreezeCommand.create({
        data: {
          shop: safeShop,
          operationId: operation?.id || null,
          sourceType: TARGET_FREEZE_SOURCE_TYPE.AUTOMATIC_PRODUCT_RULE,
          sourceId: rule.id,
          sourceRevision: rule.revision,
          configFingerprint: rule.configFingerprint,
          mirrorBatchId: store.activeMirrorBatchId,
          targetMode: rule.targetMode,
          filterAstJson: rule.filterAstJson ?? null,
          savedTargetSetId: rule.savedTargetSetId ?? null,
          editOperationJson: rule.editOperationJson,
          status: TARGET_FREEZE_COMMAND_STATUS.PENDING,
          createdAt: now,
          updatedAt: now,
        },
      });
    }

    if (tx.outboxEvent) {
      await tx.outboxEvent.create({
        data: {
          shop: safeShop,
          aggregateType: "AUTOMATIC_PRODUCT_RULE_RUN",
          aggregateId: run.id,
          eventType: "TARGET_FREEZE_REQUESTED",
          payloadJson: {
            shop: safeShop,
            operationId: operation?.id || null,
            runId: run.id,
            ruleId: rule.id,
            ruleRevision: rule.revision,
            configFingerprint: rule.configFingerprint,
            mirrorBatchId: store.activeMirrorBatchId,
          },
          status: OUTBOX_STATUS.PENDING,
          createdAt: now,
          updatedAt: now,
        },
      });
    }

    await createAuditEvent({
      tx,
      shop: safeShop,
      actor: safeActor,
      action: "AUTOMATIC_RULE_RUN_NOW_REQUESTED",
      resourceType: "AUTOMATIC_PRODUCT_RULE",
      resourceId: rule.id,
      metadata: {
        operationId: operation?.id || null,
        runId: run.id,
        ruleRevision: rule.revision,
        configFingerprint: rule.configFingerprint,
        idempotencyKey: safeIdempotencyKey,
        mirrorBatchId: store.activeMirrorBatchId,
      },
    });

    return run;
  });
}
