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
import { operationStatusBadge } from "../../shared/components/StatusBadge";
import { protectedApiPut } from "../../../api/protectedApiClient";
import { useLocaleFormatters } from "../../../hooks/useLocaleFormatters";
import TableErrorBoundary from "../../../components/Error/TableErrorBoundary";
import CellErrorBoundary from "../../../components/Error/CellErrorBoundary";

const HISTORY_TABLE_MIN_HEIGHT = "560px";

function formatStageTimestamp(entry, formatter) {
  if (!entry) return "No stage timestamps yet";
  const fmt = (v) => (v ? formatter.format(new Date(v)) : "n/a");
  return `Started: ${fmt(entry.startedAt)}\nUpdated: ${fmt(entry.updatedAt)}\nCompleted: ${fmt(entry.completedAt)}\nLease: ${fmt(entry.leaseUntil)}`;
}

const TYPE_OPTIONS = [
  { label: "historyTypeManualEdit", value: "Manual edit" },
  { label: "historyTypeScheduledEdit", value: "Scheduled edit" },
  { label: "historyTypeRecurringEdit", value: "Recurring edit" },
];

const STATUS_OPTIONS = [
  { label: "historyStatusQueued", value: "queued" },
  { label: "historyStatusProcessing", value: "processing" },
  { label: "historyStatusCompleted", value: "completed" },
  { label: "historyStatusFailed", value: "failed" },
  { label: "historyStatusCancelled", value: "cancelled" },
];

const HistoryRowActions = memo(function HistoryRowActions({
  rowId,
  onView,
  onUndo,
  undoDisabled,
  viewLabel,
  undoLabel,
}) {
  return (
    <InlineStack gap="200" wrap={false}>
      <Button size="slim" onClick={() => onView(rowId)}>{viewLabel}</Button>
      <Button size="slim" tone="critical" onClick={() => onUndo(rowId)} disabled={undoDisabled}>
        {undoLabel}
      </Button>
    </InlineStack>
  );
});

const HistoryTable = memo(function HistoryTable({
  histories,
  isLoading,
  emptyStateMessage = "No history items found.",
  onNext,
  onPrevious,
  pageInfo,
  query,
  querySearch,
  onSearchChange,
  onQueryChange,
  onQueryClear,
}) {
  const navigate = useNavigate();
  const { t } = useTranslation(["history", "common"]);
  const { dateTimeFormatter, numberFormatter } = useLocaleFormatters();
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
        label: t("historyFilterTypeLabel", {
          value: query.type,
          defaultValue: `Type: ${query.type}`,
        }),
        onRemove: () => onQueryChange({ type: "", cursor: null }),
      });
    }
    if (query.status) {
      filters.push({
        key: "status",
        label: t("historyFilterStatusLabel", {
          value: query.status,
          defaultValue: `Status: ${query.status}`,
        }),
        onRemove: () => onQueryChange({ status: "", cursor: null }),
      });
    }
    return filters;
  }, [query.type, query.status, onQueryChange, t]);

  const filterOptions = useMemo(
    () => [
      {
        key: "type",
        label: t("historyFilterType", { defaultValue: "Type" }),
        filter: (
          <ChoiceList
            title={t("historyFilterType", { defaultValue: "Type" })}
            titleHidden
            choices={TYPE_OPTIONS.map((option) => ({
              ...option,
              label: t(option.label, { defaultValue: option.value }),
            }))}
            selected={query.type ? [query.type] : []}
            onChange={(selected) => onQueryChange({ type: selected[0] || "", cursor: null })}
          />
        ),
        shortcut: true,
      },
      {
        key: "status",
        label: t("historyFilterStatus", { defaultValue: "Status" }),
        filter: (
          <ChoiceList
            title={t("historyFilterStatus", { defaultValue: "Status" })}
            titleHidden
            choices={STATUS_OPTIONS.map((option) => ({
              ...option,
              label: t(option.label, { defaultValue: option.value }),
            }))}
            selected={query.status ? [query.status] : []}
            onChange={(selected) => onQueryChange({ status: selected[0] || "", cursor: null })}
          />
        ),
        shortcut: true,
      },
    ],
    [onQueryChange, query.status, query.type, t],
  );

  const headings = useMemo(
    () => [
      { title: t("historyColumnTitle") },
      { title: t("historyColumnStatus") },
      { title: t("historyColumnProcessed") },
      { title: t("historyColumnUpdated") },
      { title: t("historyColumnActions") },
    ],
    [t],
  );

  const handleUndo = useCallback((history) => {
    setUndoHistoryItem(history);
    setShowUndoModal(true);
  }, []);
  const handleView = useCallback((rowId) => {
    navigate(`/editDetails/${rowId}`);
  }, [navigate]);
  const handleUndoById = useCallback((rowId) => {
    const target = (localHistories || []).find((entry) => String(entry?.id || "") === String(rowId));
    if (!target) return;
    handleUndo(target);
  }, [localHistories, handleUndo]);

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

  if (isLoading) {
    return (
      <Card padding="0">
        <Box minHeight={HISTORY_TABLE_MIN_HEIGHT}>
          <IndexFilters
            queryValue={querySearch}
            queryPlaceholder={t("historySearchPlaceholder", {
              defaultValue: "Search history",
            })}
            onQueryChange={onSearchChange}
            onQueryClear={onQueryClear}
            filters={filterOptions}
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
          <Box padding="500">
            <BlockStack gap="400">
              <SkeletonDisplayText size="small" />
              <SkeletonBodyText lines={10} />
            </BlockStack>
          </Box>
          <Divider />
          <Box padding="400">
            <SkeletonBodyText lines={1} />
          </Box>
        </Box>
      </Card>
    );
  }

  return (
    <Card padding="0">
      <Box minHeight={HISTORY_TABLE_MIN_HEIGHT}>
      <IndexFilters
        queryValue={querySearch}
        queryPlaceholder={t("historySearchPlaceholder", {
          defaultValue: "Search history",
        })}
        onQueryChange={onSearchChange}
        onQueryClear={onQueryClear}
        filters={filterOptions}
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
          <TableErrorBoundary>
            <IndexTable
              resourceName={{ singular: "history item", plural: "history items" }}
              itemCount={localHistories.length}
              selectable={false}
              headings={headings}
            >
              {(localHistories || []).map((item, index) => {
                const id = item.id || `row-${index}`;
                const timelineSummary = item?.timelineSummary || {};
                const stageBadges = Array.isArray(timelineSummary.stageBadges) ? timelineSummary.stageBadges : [];
                const activeStageLabel = t(
                  timelineSummary.activeStageLabelKey || "operationLifecycleStageLabels.UNKNOWN",
                  { defaultValue: timelineSummary.activeStageDefaultLabel || "UNKNOWN" },
                );

                return (
                  <IndexTable.Row id={String(id)} key={String(id)} position={index}>
                    <IndexTable.Cell>
                      <CellErrorBoundary fallback="[render error]">
                        <BlockStack gap="050">
                          <Text variant="bodyMd" fontWeight="medium" as="span">{item.title || "-"}</Text>
                          <Text variant="bodySm" tone="subdued" as="span">{item.shop?.split(".")?.[0] || "-"}</Text>
                        </BlockStack>
                      </CellErrorBoundary>
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <CellErrorBoundary fallback="[render error]">
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
                      </CellErrorBoundary>
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <CellErrorBoundary fallback="[render error]">
                        <BlockStack gap="050">
                          <Text as="span">
                            {item?.progressSummary?.label ||
                              `${numberFormatter.format(item?.processedCount || 0)} / ${numberFormatter.format(item?.totalItems || 0)}`}
                          </Text>
                          <InlineStack gap="100" wrap>
                            <Badge tone="info">{activeStageLabel}</Badge>
                            {stageBadges.map((stage) => {
                              const tooltip = `${t(stage.labelKey, { defaultValue: stage.defaultLabel })}\n${formatStageTimestamp(stage, dateTimeFormatter)}`;
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
                      </CellErrorBoundary>
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <Text as="span" variant="bodySm">
                        {item?.updatedAt ? dateTimeFormatter.format(new Date(item.updatedAt)) : "-"}
                      </Text>
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <HistoryRowActions
                        rowId={id}
                        onView={handleView}
                        onUndo={handleUndoById}
                        undoDisabled={isSyncInProgress}
                        viewLabel={t("historyViewButton")}
                        undoLabel={t("historyUndoButton")}
                      />
                    </IndexTable.Cell>
                  </IndexTable.Row>
                );
              })}
            </IndexTable>
          </TableErrorBoundary>
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
      </Box>
    </Card>
  );
});

HistoryTable.displayName = "HistoryTable";
export default HistoryTable;
