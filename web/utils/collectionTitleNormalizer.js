// web/utils/collectionTitleNormalizer.js

/**
 * Shared normalizer function for collection titles.
 * Populates titleNormalized across ingestion, reconciliation, webhooks, and backfills.
 */
export function normalizeCollectionTitle(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("en-US");
}
