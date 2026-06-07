import {
  shopifyRateLimitAvailablePoints,
  shopifyRateLimitNearExhaustion,
  shopifyRateLimitRestoreRate,
} from "../../utils/metricsUtils.js";

const BUDGET_HEADROOM_MULTIPLIER = 1.5;
const budgetManagers = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function responseExtensions(value) {
  return value?.extensions || value?.body?.extensions || null;
}

function errorStatus(error) {
  return Number(
    error?.status
      || error?.statusCode
      || error?.response?.status
      || error?.response?.statusCode
      || error?.response?.code
      || 0,
  );
}

function graphqlErrors(error) {
  const candidates = [
    error?.errors,
    error?.body?.errors,
    error?.response?.body?.errors,
  ];
  return candidates.find(Array.isArray) || [];
}

export function isThrottleError(error) {
  if (errorStatus(error) === 429) return true;

  if (
    graphqlErrors(error).some(
      (entry) => String(entry?.extensions?.code || "").toUpperCase() === "THROTTLED",
    )
  ) {
    return true;
  }

  const messages = [
    error?.message,
    ...graphqlErrors(error).map((entry) => entry?.message),
  ];
  return messages.some((message) =>
    String(message || "").toLowerCase().includes("throttled"));
}

export class ShopifyBudgetManager {
  constructor(shop, { sleepFn = sleep, nowFn = Date.now } = {}) {
    this.shop = String(shop || "").trim();
    this.currentlyAvailable = null;
    this.restoreRate = null;
    this.maximumAvailable = null;
    this.updatedAtMs = null;
    this.sleepFn = sleepFn;
    this.nowFn = nowFn;
  }

  projectedAvailable(nowMs = this.nowFn()) {
    if (this.currentlyAvailable == null) return null;
    if (this.updatedAtMs == null || !(this.restoreRate > 0)) {
      return this.currentlyAvailable;
    }

    const elapsedSeconds = Math.max(0, nowMs - this.updatedAtMs) / 1000;
    const projected = this.currentlyAvailable + elapsedSeconds * this.restoreRate;
    return this.maximumAvailable == null
      ? projected
      : Math.min(projected, this.maximumAvailable);
  }

  updateFromResponse(extensions) {
    const cost = responseExtensions(extensions)?.cost || extensions?.cost || null;
    const throttleStatus = cost?.throttleStatus;
    if (!throttleStatus) return false;

    const currentlyAvailable = Number(throttleStatus.currentlyAvailable);
    const restoreRate = Number(throttleStatus.restoreRate);
    const maximumAvailable = Number(throttleStatus.maximumAvailable);

    if (Number.isFinite(currentlyAvailable)) {
      this.currentlyAvailable = currentlyAvailable;
    }
    if (Number.isFinite(restoreRate) && restoreRate >= 0) {
      this.restoreRate = restoreRate;
    }
    if (Number.isFinite(maximumAvailable) && maximumAvailable >= 0) {
      this.maximumAvailable = maximumAvailable;
    }
    this.updatedAtMs = this.nowFn();
    if (this.shop && Number.isFinite(currentlyAvailable)) {
      shopifyRateLimitAvailablePoints.set({ shop: this.shop }, currentlyAvailable);
      if (currentlyAvailable < 100) {
        shopifyRateLimitNearExhaustion.inc({ shop: this.shop });
      }
    }
    if (this.shop && Number.isFinite(restoreRate)) {
      shopifyRateLimitRestoreRate.set({ shop: this.shop }, restoreRate);
    }
    return true;
  }

  async waitForBudget(estimatedCost) {
    const cost = Math.max(0, Number(estimatedCost) || 0);
    const requiredPoints = cost * BUDGET_HEADROOM_MULTIPLIER;
    const available = this.projectedAvailable();

    if (available == null || available >= requiredPoints) {
      return 0;
    }
    if (!(this.restoreRate > 0)) {
      return 0;
    }

    const waitMs = Math.ceil(((requiredPoints - available) / this.restoreRate) * 1000);
    await this.sleepFn(waitMs);
    return waitMs;
  }

  reserveBudget(estimatedCost) {
    const available = this.projectedAvailable();
    if (available == null) return;

    this.currentlyAvailable = Math.max(
      0,
      available - Math.max(0, Number(estimatedCost) || 0),
    );
    this.updatedAtMs = this.nowFn();
  }

  async executeWithBudget(estimatedCost, apiFn) {
    await this.waitForBudget(estimatedCost);
    this.reserveBudget(estimatedCost);

    try {
      const response = await apiFn();
      this.updateFromResponse(response);
      if (isThrottleError(response)) {
        const error = new Error(
          graphqlErrors(response)[0]?.message || "Shopify request was throttled",
        );
        error.code = "THROTTLED";
        error.body = response?.body || response;
        throw error;
      }
      return response;
    } catch (error) {
      this.updateFromResponse(error);
      throw error;
    }
  }
}

export function getBudgetManager(shop) {
  const key = String(shop || "").trim();
  if (!key) {
    throw new Error("shop is required for Shopify budget management");
  }
  if (!budgetManagers.has(key)) {
    budgetManagers.set(key, new ShopifyBudgetManager(key));
  }
  return budgetManagers.get(key);
}

export function clearBudgetManagersForTests() {
  budgetManagers.clear();
}
