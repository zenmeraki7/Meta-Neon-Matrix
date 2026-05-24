import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  IndexTable,
  IndexFilters,
  Button,
  InlineStack,
  BlockStack,
  Text,
  Box,
  EmptyState,
  SkeletonBodyText,
  SkeletonDisplayText,
  Card,
  Divider,
  Pagination,
  Tooltip,
  Badge,
  ChoiceList,
} from "@shopify/polaris";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import AlertUndo from "../../products/edit/components/AlertUndo";
import useProductSyncStatus from "../../../hooks/useProductSyncStatus";
import { buildOperationTimeline } from "../../products/edit/utils/operationTimeline";
import { operationStatusBadge } from "../../shared/components/StatusBadge";
import { protectedApiPut } from "../../../api/protectedApiClient";

function getLifecycleState(item) {
  return item?.executionState || item?.supportStatus?.executionState || item?.status || "UNKNOWN";
}

function getIdempotencyStageMap(item) {
  const entries = Array.isArray(item?.supportStatus?.idempotencyStages)
    ? item.supportStatus.idempotencyStages
    : [];
  const map = new Map();
  for (const entry of entries) {
    const stage = String(entry?.stage || "").toUpperCase();
    if (stage) map.set(stage, entry);
  }
  return map;
}

function formatStageTimestamp(entry) {
  if (!entry) return "No stage timestamps yet";
  const fmt = (v) => (v ? new Date(v).toLocaleString() : "n/a");
  return `Started: ${fmt(entry.startedAt)}\nUpdated: ${fmt(entry.updatedAt)}\nCompleted: ${fmt(entry.completedAt)}\nLease: ${fmt(entry.leaseUntil)}`;
}

const TYPE_OPTIONS = [
  { label: "Manual edit", value: "Manual edit" },
  { label: "Scheduled edit", value: "Scheduled edit" },
  { label: "Recurring edit", value: "Recurring edit" },
];

const STATUS_OPTIONS = [
  { label: "Queued", value: "queued" },
  { label: "Processing", value: "processing" },
  { label: "Completed", value: "completed" },
  { label: "Failed", value: "failed" },
  { label: "Cancelled", value: "cancelled" },
];

const HistoryTable = memo(function HistoryTable({
  histories,
  isLoading,
  emptyStateMessage = "No history items found.",
  onNext,
  onPrevious,
  pageInfo,
  query,
  onQueryChange,
  onQueryClear,
}) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { isSyncInProgress } = useProductSyncStatus();
  const [showUndoModal, setShowUndoModal] = useState(false);
  const [undoLoading, setUndoLoading] = useState(false);
  const [undoHistoryItem, setUndoHistoryItem] = useState(null);
  const [localHistories, setLocalHistories] = useState(() => histories || []);

  useEffect(() => {
    setLocalHistories(histories || []);
  }, [histories]);

  const appliedFilters = useMemo(() => {
    const filters = [];
    if (query.type) {
      filters.push({
        key: "type",
        label: `Type: ${query.type}`,
        onRemove: () => onQueryChange({ type: "", cursor: null }),
      });
    }
    if (query.status) {
      filters.push({
        key: "status",
        label: `Status: ${query.status}`,
        onRemove: () => onQueryChange({ status: "", cursor: null }),
      });
    }
    return filters;
  }, [query.type, query.status, onQueryChange]);

  const handleUndo = useCallback((history) => {
    setUndoHistoryItem(history);
    setShowUndoModal(true);
  }, []);

  const handleUndoEditHistory = useCallback(async () => {
    if (!undoHistoryItem?.id) return;
    setUndoLoading(true);
    try {
      await protectedApiPut(`/api/products/undo-edit/${undoHistoryItem.id}`, undefined, {
        idempotent: true,
      });
      setShowUndoModal(false);
    } finally {
      setUndoLoading(false);
    }
  }, [undoHistoryItem]);

  const rows = useMemo(() => {
    return (localHistories || []).map((item, index) => {
      const id = item.id || `row-${index}`;
      const timeline = buildOperationTimeline(getLifecycleState(item));
      const activeStage = timeline.stages.find((s) => s.status === "active");
      const activeStageLabel = activeStage
        ? t(activeStage.labelKey, { defaultValue: activeStage.defaultLabel })
        : t(`operationLifecycleStageLabels.${timeline.currentState}`, {
            defaultValue: timeline.currentState,
          });
      const stageMetaMap = getIdempotencyStageMap(item);

      return (
        <IndexTable.Row id={String(id)} key={String(id)} position={index}>
          <IndexTable.Cell>
            <BlockStack gap="050">
              <Text variant="bodyMd" fontWeight="medium" as="span">{item.title || "-"}</Text>
              <Text variant="bodySm" tone="subdued" as="span">{item.shop?.split(".")?.[0] || "-"}</Text>
            </BlockStack>
          </IndexTable.Cell>

          <IndexTable.Cell>
            <InlineStack gap="150" wrap>
              {operationStatusBadge(
                item?.primaryStatus?.key || item?.status,
                t(`historyStatus.${String(item?.primaryStatus?.key || item?.status || "pending").toLowerCase()}`, {
                  defaultValue: String(item?.status || "pending"),
                }),
              )}
              {item?.undoStatusSummary?.key
                ? operationStatusBadge(
                    item.undoStatusSummary.key,
                    t(`historyStatus.${item.undoStatusSummary.key}`, { defaultValue: item.undoStatusSummary.key }),
                  )
                : null}
            </InlineStack>
          </IndexTable.Cell>

          <IndexTable.Cell>
            <BlockStack gap="050">
              <Text as="span">{item?.progressSummary?.label || `${item?.processedCount || 0} / ${item?.totalItems || 0}`}</Text>
              <InlineStack gap="100" wrap>
                <Badge tone="info">{activeStageLabel}</Badge>
                {timeline.stages.slice(0, 5).map((stage) => {
                  const meta = stageMetaMap.get(String(stage.key || "").toUpperCase()) || null;
                  const tooltip = `${t(stage.labelKey, { defaultValue: stage.defaultLabel })}\n${formatStageTimestamp(meta)}`;
                  return (
                    <Tooltip key={`${id}-${stage.key}`} content={tooltip}>
                      <Badge tone={stage.status === "completed" ? "success" : stage.status === "active" ? "info" : "attention"}>
                        {String(stage.key).slice(0, 3)}
                      </Badge>
                    </Tooltip>
                  );
                })}
              </InlineStack>
            </BlockStack>
          </IndexTable.Cell>

          <IndexTable.Cell>
            <Text as="span" variant="bodySm">{item?.updatedAt ? new Date(item.updatedAt).toLocaleString() : "-"}</Text>
          </IndexTable.Cell>

          <IndexTable.Cell>
            <InlineStack gap="200" wrap={false}>
              <Button size="slim" onClick={() => navigate(`/editDetails/${id}`)}>{t("historyViewButton")}</Button>
              <Button size="slim" tone="critical" onClick={() => handleUndo(item)} disabled={isSyncInProgress}>
                {t("historyUndoButton")}
              </Button>
            </InlineStack>
          </IndexTable.Cell>
        </IndexTable.Row>
      );
    });
  }, [localHistories, t, navigate, handleUndo, isSyncInProgress]);

  if (isLoading) {
    return (
      <Card padding="0">
        <Box padding="500">
          <BlockStack gap="400">
            <SkeletonDisplayText size="small" />
            <SkeletonBodyText lines={6} />
          </BlockStack>
        </Box>
      </Card>
    );
  }

  return (
    <Card padding="0">
      <IndexFilters
        queryValue={query.search}
        queryPlaceholder="Search history"
        onQueryChange={(value) => onQueryChange({ search: value, cursor: null })}
        onQueryClear={onQueryClear}
        filters={[
          {
            key: "type",
            label: "Type",
            filter: (
              <ChoiceList
                title="Type"
                titleHidden
                choices={TYPE_OPTIONS}
                selected={query.type ? [query.type] : []}
                onChange={(selected) => onQueryChange({ type: selected[0] || "", cursor: null })}
              />
            ),
            shortcut: true,
          },
          {
            key: "status",
            label: "Status",
            filter: (
              <ChoiceList
                title="Status"
                titleHidden
                choices={STATUS_OPTIONS}
                selected={query.status ? [query.status] : []}
                onChange={(selected) => onQueryChange({ status: selected[0] || "", cursor: null })}
              />
            ),
            shortcut: true,
          },
        ]}
        appliedFilters={appliedFilters}
        onClearAll={onQueryClear}
        cancelAction={{ onAction: () => {}, disabled: true, loading: false }}
        tabs={[]}
        selected={0}
        onSelect={() => {}}
        canCreateNewView={false}
        mode="default"
        setMode={() => {}}
      />

      <Divider />

      {!localHistories?.length ? (
        <Box padding="1200">
          <EmptyState heading={t("historyEmptyStateTitle")}>
            <p>{emptyStateMessage}</p>
          </EmptyState>
        </Box>
      ) : (
        <Box overflowX="auto" paddingInlineStart="800">
          <IndexTable
            resourceName={{ singular: "history item", plural: "history items" }}
            itemCount={localHistories.length}
            selectable={false}
            headings={[
              { title: t("historyColumnTitle") },
              { title: t("historyColumnStatus") },
              { title: t("historyColumnProcessed") },
              { title: t("historyColumnUpdated") },
              { title: t("historyColumnActions") },
            ]}
          >
            {rows}
          </IndexTable>
        </Box>
      )}

      <Divider />
      <Box padding="400">
        <Pagination
          hasNext={Boolean(pageInfo?.hasNextPage)}
          hasPrevious={Boolean(pageInfo?.hasPreviousPage)}
          onNext={onNext}
          onPrevious={onPrevious}
        />
      </Box>

      <AlertUndo
        show={showUndoModal}
        handleClose={() => setShowUndoModal(false)}
        undoEditHistory={handleUndoEditHistory}
        loading={undoLoading}
      />
    </Card>
  );
});

HistoryTable.displayName = "HistoryTable";
export default HistoryTable;
