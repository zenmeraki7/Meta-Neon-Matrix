import { db } from "../../../repositories/repositoryDb.js";
import { Prisma } from "../../../repositories/prismaTypes.js";

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
      shop_requestIdempotencyKey: {
        shop,
        requestIdempotencyKey: idempotencyKey,
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

  return db.$transaction(async (tx) => {
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
          ruleConfigHash: rule.ruleConfigHash,
          metadataJson: {
            ruleId: rule.id,
            ruleRevision: rule.revision,
            ruleConfigHash: rule.ruleConfigHash,
            mirrorBatchId: store.currentProductMirrorBatchId,
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
          triggerSource: OPERATION_SOURCE.AUTOMATIC_RULE_RUN_NOW,
          changeSource: OPERATION_SOURCE.AUTOMATIC_RULE_RUN_NOW,
          ruleRevision: rule.revision,
          ruleConfigHash: rule.ruleConfigHash,
          requestIdempotencyKey: safeIdempotencyKey,
          status: RUN_STATUS.TARGET_FREEZE_QUEUED,
          requestedByJson: safeActor,
          mirrorBatchId: store.currentProductMirrorBatchId,
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

    if (
      rule.targetResolutionMode === "DYNAMIC_FILTER"
      && (!rule.normalizedFilterAst || typeof rule.normalizedFilterAst !== "object")
    ) {
      const error = new Error("AUTOMATIC_RULE_NORMALIZED_FILTER_REQUIRED");
      error.code = "AUTOMATIC_RULE_NORMALIZED_FILTER_REQUIRED";
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
          ruleConfigHash: rule.ruleConfigHash,
          mirrorBatchId: store.currentProductMirrorBatchId,
          targetResolutionMode: rule.targetResolutionMode,
          filterAst: rule.normalizedFilterAst ?? null,
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
          domainEventType: "TARGET_FREEZE_REQUESTED",
          payloadJson: {
            shop: safeShop,
            operationId: operation?.id || null,
            automaticRuleRunId: run.id,
            ruleId: rule.id,
            ruleRevision: rule.revision,
            ruleConfigHash: rule.ruleConfigHash,
            mirrorBatchId: store.currentProductMirrorBatchId,
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
        automaticRuleRunId: run.id,
        ruleRevision: rule.revision,
        ruleConfigHash: rule.ruleConfigHash,
        idempotencyKey: safeIdempotencyKey,
        mirrorBatchId: store.currentProductMirrorBatchId,
      },
    });

    return run;
  });
}
