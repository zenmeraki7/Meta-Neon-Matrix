import { prisma } from "../config/database.js";
import { buildAutomaticRuleTargetIdentity } from "../utils/automaticRuleTargetIdentityUtils.js";

const STATE_LOOKUP_BATCH_SIZE = 1000;

function getClient(db) {
  return db || prisma;
}

function assertStateOwnerPayload({ automaticProductRuleId, shop }) {
  if (!automaticProductRuleId || typeof automaticProductRuleId !== "string") {
    throw new Error("automaticProductRuleId is required for automatic rule state");
  }

  if (!shop || typeof shop !== "string") {
    throw new Error("shop is required for automatic rule state");
  }
}

function assertTargetPayload({ targetResourceType, targetIdentity, productId, variantId }) {
  if (!targetIdentity || typeof targetIdentity !== "string") {
    throw new Error("targetIdentity is required for automatic rule state");
  }

  if (targetResourceType === "PRODUCT") {
    if (!productId || variantId) {
      throw new Error("PRODUCT scoped rule state requires productId and null variantId");
    }
    const expected = buildAutomaticRuleTargetIdentity({ targetResourceType, productId });
    if (targetIdentity !== expected) {
      throw new Error("PRODUCT scoped rule state targetIdentity mismatch");
    }
    return;
  }

  if (targetResourceType === "VARIANT") {
    if (!productId || !variantId) {
      throw new Error("VARIANT scoped rule state requires productId and variantId");
    }
    const expected = buildAutomaticRuleTargetIdentity({ targetResourceType, productId, variantId });
    if (targetIdentity !== expected) {
      throw new Error("VARIANT scoped rule state targetIdentity mismatch");
    }
    return;
  }

  throw new Error(`Unsupported automatic rule target type: ${targetResourceType}`);
}

function pickMutableStateData(data = {}) {
  const allowedKeys = [
    "lastMatchedAt",
    "lastAppliedAt",
    "lastFingerprint",
    "suppressedUntil",
    "lastMirrorBatchId",
    "lastTriggerReference",
    "lastAutomaticRuleRunId",
  ];

  return allowedKeys.reduce((accumulator, key) => {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      accumulator[key] = data[key];
    }
    return accumulator;
  }, {});
}

async function findByIdentityChunks(client, whereBase, targetIdentities) {
  const results = [];

  for (let i = 0; i < targetIdentities.length; i += STATE_LOOKUP_BATCH_SIZE) {
    const chunk = targetIdentities.slice(i, i + STATE_LOOKUP_BATCH_SIZE);
    const rows = await client.automaticProductRuleProductState.findMany({
      where: {
        ...whereBase,
        targetIdentity: { in: chunk },
      },
    });
    results.push(...rows);
  }

  return results;
}

export const automaticProductRuleStateRepository = {
  async findByRuleAndTargetIdentities(
    automaticProductRuleId,
    shop,
    targetIdentities = [],
    db = prisma,
  ) {
    assertStateOwnerPayload({ automaticProductRuleId, shop });
    const identities = [...new Set(targetIdentities.filter(Boolean))];
    if (!identities.length) return [];

    return findByIdentityChunks(
      getClient(db),
      {
        automaticProductRuleId,
        shop,
      },
      identities,
    );
  },

  async upsertState(
    { automaticProductRuleId, shop, targetResourceType, targetIdentity, productId = null, variantId = null, data = {} },
    db = prisma,
  ) {
    assertStateOwnerPayload({ automaticProductRuleId, shop });
    assertTargetPayload({
      targetResourceType,
      targetIdentity,
      productId,
      variantId,
    });
    const mutableData = pickMutableStateData(data);

    return getClient(db).automaticProductRuleProductState.upsert({
      where: {
        automaticProductRuleId_shop_targetIdentity: {
          automaticProductRuleId,
          shop,
          targetIdentity,
        },
      },
      update: mutableData,
      create: {
        ...mutableData,
        automaticProductRuleId,
        shop,
        targetResourceType,
        targetIdentity,
        productId,
        variantId,
      },
    });
  },
};
