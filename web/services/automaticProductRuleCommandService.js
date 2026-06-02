import {
  createAutomaticProductRule,
  pauseAutomaticProductRule,
  resumeAutomaticProductRule,
  runAutomaticProductRuleNow,
  softDeleteAutomaticProductRule,
  updateAutomaticProductRule,
} from "./automaticProductRuleService.js";

export const automaticProductRuleCommandService = {
  async createRule({ shop, actor, command, entitlement, subscription }) {
    return createAutomaticProductRule({
      shop,
      actor,
      command,
      entitlement: entitlement || subscription || null,
    });
  },

  async updateRule({ shop, actor, ruleId, patchCommand, entitlement }) {
    return updateAutomaticProductRule({
      shop,
      automaticProductRuleId: ruleId,
      command: patchCommand,
      entitlement,
      actor,
    });
  },

  async pauseRule({ shop, actor, ruleId, pausePolicy }) {
    return pauseAutomaticProductRule({
      shop,
      automaticProductRuleId: ruleId,
      actor,
      pausePolicy,
    });
  },

  async resumeRule({ shop, actor, ruleId, entitlement }) {
    return resumeAutomaticProductRule({
      shop,
      automaticProductRuleId: ruleId,
      actor,
      entitlement,
    });
  },

  async runRuleNow({ shop, actor, ruleId, idempotencyKey, entitlement, expectedRuleRevision }) {
    return runAutomaticProductRuleNow({
      shop,
      automaticProductRuleId: ruleId,
      actor,
      idempotencyKey,
      entitlement,
      expectedRuleRevision,
    });
  },

  async deleteRule({ shop, actor, ruleId, deleteCommand }) {
    return softDeleteAutomaticProductRule({
      shop,
      automaticProductRuleId: ruleId,
      actor,
      deleteCommand,
    });
  },
};

export default automaticProductRuleCommandService;
