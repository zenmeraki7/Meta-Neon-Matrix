import { db } from "../../../repositories/repositoryDb.js";
import { assertRuleId, assertShop } from "../automaticProductRuleGuards.js";
import { publicError } from "../automaticProductRuleErrors.js";

export async function listAutomaticProductRules({ shop, pagination = {} }) {
  const safeShop = assertShop(shop);

  return db.automaticProductRule.findMany({
    where: { shop: safeShop, deletedAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(pagination?.cursorId ? { cursor: { id: pagination.cursorId }, skip: 1 } : {}),
    take: Number(pagination?.limit || 50),
  });
}

export async function getAutomaticProductRuleById({ shop, automaticProductRuleId }) {
  const safeShop = assertShop(shop);
  const safeRuleId = assertRuleId(automaticProductRuleId);

  const rule = await db.automaticProductRule.findFirst({
    where: { shop: safeShop, id: safeRuleId, deletedAt: null },
  });

  if (!rule) {
    throw publicError("RULE_NOT_FOUND", 404, "Automatic product rule not found.");
  }

  return rule;
}

export async function listAutomaticProductRuleRuns({ shop, automaticProductRuleId, pagination = {} }) {
  const safeShop = assertShop(shop);
  const safeRuleId = assertRuleId(automaticProductRuleId);

  await getAutomaticProductRuleById({ shop: safeShop, automaticProductRuleId: safeRuleId });

  return db.automaticProductRuleRun.findMany({
    where: { shop: safeShop, automaticProductRuleId: safeRuleId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(pagination?.cursorId ? { cursor: { id: pagination.cursorId }, skip: 1 } : {}),
    take: Number(pagination?.limit || 50),
  });
}

