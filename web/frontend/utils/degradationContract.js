export const DEGRADATION_MESSAGES = Object.freeze({
  MIRROR_UNSAFE: {
    title: "Product data is refreshing",
    body: "Bulk editing is temporarily unavailable while we update your product data. This usually takes 5-10 minutes. No action needed.",
    showRetryAt: true,
    recoveryWindow: "5-10 minutes",
  },
  SHOPIFY_UNAVAILABLE: {
    title: "Shopify is temporarily unavailable",
    body: "Your bulk edit has been paused and will resume automatically when Shopify is back online. No action needed.",
    showRetryAt: true,
    recoveryWindow: "automatically when Shopify is available",
  },
  RATE_LIMIT_SUSPENDED: {
    title: "Processing slowed to protect your store",
    body: "Your bulk edit is processing at a reduced rate to stay within Shopify's limits. It will complete automatically. No action needed.",
    showRetryAt: false,
    recoveryWindow: "automatically as Shopify capacity restores",
  },
  JOB_SUSPENDED: {
    title: "Bulk edit paused",
    body: "Your edit has been paused due to a temporary issue. It will resume automatically. No action needed.",
    showRetryAt: true,
    recoveryWindow: "within a few minutes",
  },
});

export function getDegradationContract(value, fallbackCode = "JOB_SUSPENDED") {
  const supplied = value?.title && value?.body
    ? value
    : value?.degradation || value?.payload?.degradation || value?.details?.degradation;
  if (supplied?.title && supplied?.body) {
    return {
      ...DEGRADATION_MESSAGES[fallbackCode],
      ...supplied,
    };
  }
  const raw = String(value?.code || value?.errorCode || fallbackCode).toUpperCase();
  const code = DEGRADATION_MESSAGES[raw] ? raw : fallbackCode;
  return { code, ...DEGRADATION_MESSAGES[code] };
}

export function formatExpectedRecovery(contract, locale) {
  if (contract?.showRetryAt && contract?.retryAt) {
    const retryAt = new Date(contract.retryAt);
    if (Number.isFinite(retryAt.getTime())) {
      return `Expected recovery: ${retryAt.toLocaleString(locale)}.`;
    }
  }
  return `Expected recovery: ${contract?.recoveryWindow || "within a few minutes"}.`;
}
