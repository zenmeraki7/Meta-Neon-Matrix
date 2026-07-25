# Identity and lifecycle terminology

Polymorphic identity pairs are domain-specific and must not be converted through
generic `{ type, id }` helpers:

- `aggregateType / aggregateId`: domain-event aggregate identity.
- `ownerType / ownerId`: owner of a metafield or frozen target snapshot.
- `entityType / entityId`: mirror reconciliation or mutation-journal entity.
- `resourceType / resourceId`: leased or idempotency-protected resource.
- `sourceType / sourceId`: source command that initiated a workflow.

Use the matching constructor in `utils/polymorphicIdentity.js` with an explicit
allow-list for the subsystem. A value validated for one pair must be validated
again before use in another domain.

Lifecycle terminology:

- `status`: final or domain lifecycle.
- `executionState`: runtime claims, retries, and processing lifecycle.
- `stage`: current pipeline phase.
- `healthState`: mirror/system health.
- `shopifyStatus`: raw external Shopify lifecycle.
- `dispatchStatus`: queue-dispatch lifecycle.

`UndoOperation.outcomeStatus` is the durable business result;
`UndoOperation.executionState` is the retryable runtime state machine.

Actor terminology:

- `actorType / actorId / actorEmail / actorDisplayName`: the initiating actor snapshot.
- `createdByActorId / updatedByActorId / cancelledByActorId`: the actor identity for a lifecycle transition.
- `legacyUser`: source-preservation only; workflow code must not read it.

Timestamp terminology:

- `createdAt`: the database record was created.
- `requestedAt`: a user or system requested the operation.
- `queuedAt`: a durable queue intent was accepted.
- `dispatchedAt`: work was sent to an external queue.
- `startedAt`: execution began.
- `completedAt`: execution reached a terminal state.
- `scheduledFor`: the intended execution instant.

`EditHistory.requestedAt` maps the legacy PostgreSQL `editTime` column. API
serializers may temporarily emit `editTime`, but persistence and cursor queries
must use `requestedAt`.

Failure terminology:

- `failureCode / failureMessage / failureStage / failureDetails / failedAt`: terminal failure envelope.
- `lastFailureCode / lastFailureMessage / lastFailureAt`: most recent retry failure.
- `shopifyErrorCode / shopifyErrorMessage`: explicitly external Shopify failure.

Field-change terminology:

- `selectedFieldKeys`: user-selected export/edit fields.
- `plannedMutation`: immutable proposed mutation.
- `appliedFieldChanges`: actual persisted result.
- `affectedFieldKeys`: derived summary of applied changes.

Public request compatibility may still accept `fields`, but persisted models,
commands, hashes, and queue payloads use `selectedFieldKeys`.

Filter terminology:

- `rawFilterInput`: untrusted browser/request input.
- `filterAst`: parsed filter syntax.
- `normalizedFilterAst`: validated canonical execution input.
- `canonicalFilterKey`: stable semantic cache identity.
- `normalizedFilterHash`: SHA-256 of the deeply key-sorted normalized filter AST.

`legacyQueryFilter`, `legacyFilterQuery`, and `legacyFilterAst` are migration
projections only. Dynamic automatic-rule dispatch fails closed unless a trusted
`normalizedFilterAst` is present.

Target terminology:

- `targetResolutionMode`: FILTER, SAVED_SET, or EXPLICIT_IDS source selection.
- `targetResourceType`: PRODUCT, VARIANT, METAFIELD, or another domain resource.
- `targetGranularity`: PRODUCT, VARIANT, or INVENTORY_ITEM result granularity.
- `targetFreezeMode`: STATIC or RESOLVE_AT_EXECUTION snapshot timing.

Snapshot and file terminology:

- `beforeValues / plannedMutation / afterValues / undoMutation`: snapshot phases.
- `originalFilename`: user-provided name.
- `generatedFilename`: app-generated download name.
- `storageKey`: durable object identity.
- `downloadUrl`: download/access URL.
- `shopifyStagedUploadPath`: Shopify staged-upload path.
- `sourceResponseUrl`: external Shopify result URL.

Integrity terminology:

- `ruleConfigHash`: SHA-256 over stable JSON containing command version, target
  resolution mode, parsed and normalized filter input, saved target-set ID,
  edit operation, schedule, and timezone (`v1`). It detects configuration
  equality; it is not an authentication primitive.
- `targetDefinitionHash`: SHA-256 identity of the resolved target definition
  (tenant, operation/preview contract, mirror batch, and canonical targeting
  contract). It must not be substituted for a filter or row hash.
- `normalizedFilterHash`: SHA-256 over the canonical normalized filter AST
  (`deep-key-sort-json-v1`).
- `targetRowHash`: SHA-256 of the qualified target identity such as
  `PRODUCT:<gid>` or `VARIANT:<gid>`.
- `rowChecksum`: SHA-256 over stable JSON containing snapshot identity,
  tenant, operation, mirror batch, qualified target identity, before values,
  planned mutation, target-row hash, compiler version, and projection version
  (`sha256-stable-json-v1`).
- `targetSetHash`: SHA-256 over stable JSON containing the target-set identity,
  version bundle, all four composition counts, and sorted row checksums
  (`sha256-stable-json-v2`; legacy sets may retain the v1 hash).
- `fileChecksum`, `payloadHash`, `commandHash`, and
  `ingestionRollingChecksum` are separate integrity domains. Producers must
  persist their algorithm/version beside cross-service data; none is an HMAC
  or proof of authenticity unless explicitly documented as such.

Source and event-time terminology:

- `changeSource`: origin of a persisted mutation (webhook, polling, import, or
  reconciliation).
- `triggerSource`: origin that started a workflow execution.
- `ingestionSource`: origin of imported input or result data.
- `sourceEventType`: external event classification.
- `sourceSystem`: owning external system.
- `sourceEntityUpdatedAt`: external entity's update clock.
- `sourceEventOccurredAt`: external event occurrence clock.
- `sourceEventReceivedAt`: local receipt clock.
- `updatedAt`: local row-update clock.

Mirror and batch terminology:

- `mirrorMutationSequence`: mutation-journal ordering position.
- `tombstoneMutationSequence`: journal position that created a tombstone.
- `replayStartSequence`: journal boundary captured when a mirror batch starts.
- `replayFinalizedThroughSequence`: highest journal sequence incorporated before
  batch activation.
- `currentProductMirrorBatchId` and `currentCollectionMirrorBatchId`: current
  active Store pointers.
- `expectedPreviousActiveBatchId`: compare-and-swap expectation for activation.
- `targetProductMirrorBatchId`: immutable product batch targeted by a workflow.
- `processingChunkId`: bounded internal processing chunk.
- `shopifySubmissionBatchId`: Shopify mutation submission group.

Queue terminology:

- `queueName`: physical queue.
- `queueRoutingKey`: logical in-process routing selector.
- `queueJobName` / `queueJobId`: external queue job identity.
- `dispatchDedupeKey`: cross-retry dispatch identity.
- `availableAt`: earliest claim time.
- `dispatchAttemptCount`: number of dispatch claims.

Target snapshot counter semantics:

- Composition counters are `productCount`, `variantCount`,
  `inventoryItemCount`, and `metafieldCount`. They are exclusive and their sum
  must equal `targetCount`.
- Mutation counters are `mutationPendingCount`, `mutationSubmittedCount`,
  `mutationSucceededCount`, `mutationFailedCount`, and
  `mutationSkippedCount`. They mirror the exclusive `executionStatus` buckets
  and their sum must equal `targetCount`.
- Verification is a separate nullable item state machine. A null
  `verificationStatus` means verification is not applicable or has not been
  scheduled. `PENDING`, `SUCCEEDED`, and `FAILED` are summarized independently
  by the three `verification*Count` fields; their sum cannot exceed
  `mutationSucceededCount`.
- Undo has six exclusive buckets: `undoNotRequiredCount`, `undoPendingCount`,
  `undoSubmittedCount`, `undoSucceededCount`, `undoFailedCount`, and
  `undoSkippedCount`. Every target has exactly one undo state, so their sum must
  equal `targetCount`. `NOT_REQUIRED` is a real current state, not absence of an
  undo row.

Bulk-apply counter semantics:

- `eligibleItemCount` means the authoritative number of persisted
  `BulkApplyItem` rows after input deduplication.
- `pendingItemCount`, `applyingItemCount`, `appliedItemCount`,
  `failedItemCount`, `cancelledItemCount`, and `skippedItemCount` are exclusive
  current-state buckets. `FAILED` and `FAILED_PERMANENT` both contribute to the
  failure bucket.
- `appliedItemCount` means the item reached the `APPLIED` state; it is not a
  submitted or cumulative-attempt count.
- A terminal request has no pending or applying items, and the sum of its four
  terminal buckets equals `eligibleItemCount`.

`VERIFIED` is not a mutation execution status. Verification success or failure
never removes an item from the `SUCCEEDED` mutation bucket.

Deletion and installation:

- `deletedAt` is the authoritative automatic-rule soft-delete marker. New
  deletes preserve the rule's last domain `status`; `DELETED` is accepted only
  while historical rows are backfilled. `legacyIsDeleted` is a temporary,
  explicitly named compatibility projection and is never queried.
- `installationStatus` is the authoritative Store lifecycle. The legacy Boolean
  is retained and dual-written only as `legacyIsUninstalled` during migration;
  reads and worker claims use the enum. `LegacyShop.legacyActive` is inert and
  no operational model relates to the legacy table.
- Shopify OAuth permissions use `oauthScopes`. `scope` is allowed only as the
  external Shopify session-library property at the adapter boundary.
