import { Worker } from "bullmq";
import { connection } from "../../config/redis.js";
import { UndoResultIngestionService } from "../../services/undo/UndoResultIngestionService.js";

const QUEUE_NAME =
  process.env.BULK_UNDO_RESULT_INGEST_QUEUE || "bulk-undo-result-ingest";

async function processBulkUndoResultIngest(job) {
  const shop = job.data?.shop;
  const shopifyBulkOperationId = job.data?.shopifyBulkOperationId;
  const status = job.data?.status || null;
  if (!shop || !shopifyBulkOperationId) {
    throw new Error(
      "bulk undo result ingest job requires shop and shopifyBulkOperationId"
    );
  }
  const service = new UndoResultIngestionService();
  const result = await service.ingestUndoBulkOperationWebhook({
    shop,
    shopifyBulkOperationId: String(shopifyBulkOperationId),
    status,
    resultUrl: job.data?.url || job.data?.partialDataUrl || null,
  });

  return {
    success: true,
    shop,
    shopifyBulkOperationId,
    result,
  };
}

const bulkUndoResultIngestWorker = new Worker(
  QUEUE_NAME,
  processBulkUndoResultIngest,
  {
    connection,
    concurrency: 1,
  }
);

export default bulkUndoResultIngestWorker;
