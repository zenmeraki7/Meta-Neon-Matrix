import client from "prom-client";

// Collect Node.js process and system metrics automatically
client.collectDefaultMetrics();

// Define metrics for product operations
export const productFetchDuration = new client.Histogram({
  name: "product_fetch_duration_seconds",
  help: "Time taken to fetch products from Shopify API or DB",
  labelNames: ["shop"],
  buckets: [0.1, 0.3, 0.5, 1, 2, 5],
});

export const productFetchTotal = new client.Counter({
  name: "product_fetch_total",
  help: "Total number of product fetch operations",
  labelNames: ["shop", "status"], // success or failed
});

export const productFetchErrorsTotal = new client.Counter({
  name: "product_fetch_errors_total",
  help: "Total number of failed product fetch operations",
  labelNames: ["shop", "errorType"],
});

export const bulkEditJobTransitions = new client.Counter({
  name: "bulk_edit_job_transition_total",
  help: "EditHistory lifecycle transitions",
  labelNames: ["shop", "from_status", "to_status", "type", "field"],
});

export const bulkEditJobDurationMs = new client.Histogram({
  name: "bulk_edit_job_duration_ms",
  help: "Terminal bulk edit job duration in milliseconds",
  labelNames: ["shop", "status", "type"],
  buckets: [1_000, 5_000, 15_000, 30_000, 60_000, 300_000, 900_000, 1_800_000],
});

export const bulkEditChangeRecordOutcomes = new client.Counter({
  name: "bulk_edit_change_record_outcome_total",
  help: "Finalized bulk edit change-record outcomes",
  labelNames: ["shop", "status", "failure_code"],
});

export const mirrorPendingRecords = new client.Gauge({
  name: "mirror_pending_records",
  help: "Pending mirror change records at finalization",
  labelNames: ["shop"],
});

export const mirrorFinalizationResults = new client.Counter({
  name: "mirror_finalization_result_total",
  help: "Mirror finalization results",
  labelNames: ["shop", "result"],
});

export const shopifyRateLimitAvailablePoints = new client.Gauge({
  name: "shopify_rate_limit_available_points",
  help: "Currently available Shopify GraphQL cost points",
  labelNames: ["shop"],
});

export const shopifyRateLimitRestoreRate = new client.Gauge({
  name: "shopify_rate_limit_restore_rate",
  help: "Shopify GraphQL cost points restored per second",
  labelNames: ["shop"],
});

export const shopifyRateLimitNearExhaustion = new client.Counter({
  name: "shopify_rate_limit_near_exhaustion_total",
  help: "Shopify GraphQL budget observations below 100 points",
  labelNames: ["shop"],
});

export const webhookProcessingLagMs = new client.Histogram({
  name: "webhook_processing_lag_ms",
  help: "Delay from webhook delivery creation to worker pickup",
  labelNames: ["shop", "topic"],
  buckets: [100, 500, 1_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000],
});

export const bulkEditStuckJobs = new client.Gauge({
  name: "bulk_edit_stuck_jobs",
  help: "EditHistory jobs pending or processing for more than 30 minutes",
  labelNames: ["shop"],
});

export const bulkEditChangeRecordFailureRate = new client.Gauge({
  name: "bulk_edit_change_record_failure_rate",
  help: "Failed ChangeRecord ratio over the last 10 minutes",
  labelNames: ["shop"],
});

/**
 * Middleware/handler for exposing Prometheus metrics
 */
export const metricsEndpoint = async (req, res) => {
  res.set("Content-Type", client.register.contentType);
  const metrics = await client.register.metrics();
  res.end(metrics);
};

export default {
  productFetchDuration,
  productFetchTotal,
  productFetchErrorsTotal,
  bulkEditJobTransitions,
  bulkEditJobDurationMs,
  bulkEditChangeRecordOutcomes,
  mirrorPendingRecords,
  mirrorFinalizationResults,
  shopifyRateLimitAvailablePoints,
  shopifyRateLimitRestoreRate,
  shopifyRateLimitNearExhaustion,
  webhookProcessingLagMs,
  bulkEditStuckJobs,
  bulkEditChangeRecordFailureRate,
  metricsEndpoint,
};
