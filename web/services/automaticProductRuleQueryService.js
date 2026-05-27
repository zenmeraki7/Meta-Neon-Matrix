import {
  getAutomaticProductRuleById,
  listAutomaticProductRuleRuns,
  listAutomaticProductRules,
} from "./automaticProductRuleService.js";

function buildPageInfo({ cursor, limit, items = [] }) {
  const safeLimit = Number(limit) || 50;
  const hasNextPage = Array.isArray(items) && items.length >= safeLimit;
  return {
    hasNextPage,
    hasPreviousPage: Boolean(cursor),
    nextCursor: hasNextPage ? items[items.length - 1]?.id || null : null,
    previousCursor: cursor || null,
  };
}

export const automaticProductRuleQueryService = {
  async listRules({ shop, page }) {
    const rules = await listAutomaticProductRules({
      shop,
      pagination: {
        cursorId: page.cursor,
        limit: page.limit,
        sortKey: page.sortKey,
        sortDirection: page.sortDirection,
      },
    });

    const allowedStatuses = Array.isArray(page.statuses) && page.statuses.length
      ? new Set(page.statuses.map((s) => String(s).toUpperCase()))
      : new Set(["ACTIVE", "PAUSED"]);
    const filtered = rules.filter((rule) => {
      const currentStatus = String(rule.statusKey || rule.status).toUpperCase();
      if (!allowedStatuses.has(currentStatus)) {
        return false;
      }
      if (page.status && currentStatus !== page.status) return false;
      if (page.search) {
        const haystack = `${rule.title || ""}`.toLowerCase();
        if (!haystack.includes(String(page.search).toLowerCase())) return false;
      }
      return true;
    });

    return {
      rules: filtered,
      pageInfo: buildPageInfo({ cursor: page.cursor, limit: page.limit, items: filtered }),
    };
  },

  async getRuleDetail({ shop, ruleId }) {
    return getAutomaticProductRuleById({ shop, automaticProductRuleId: ruleId });
  },

  async listRuleRuns({ shop, ruleId, page }) {
    const runs = await listAutomaticProductRuleRuns({
      shop,
      automaticProductRuleId: ruleId,
      pagination: {
        cursorId: page.cursor,
        limit: page.limit,
        sortKey: page.sortKey,
        sortDirection: page.sortDirection,
      },
    });
    const filtered = runs.filter((run) => {
      if (page.status && String(run.status).toUpperCase() !== page.status) return false;
      if (page.startedAfter && run.startedAt && new Date(run.startedAt) < new Date(page.startedAfter)) return false;
      if (page.startedBefore && run.startedAt && new Date(run.startedAt) > new Date(page.startedBefore)) return false;
      return true;
    });
    return {
      runs: filtered,
      pageInfo: buildPageInfo({ cursor: page.cursor, limit: page.limit, items: filtered }),
    };
  },
};

export default automaticProductRuleQueryService;
