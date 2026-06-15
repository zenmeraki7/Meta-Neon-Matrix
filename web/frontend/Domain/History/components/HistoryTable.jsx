import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
  Badge,
  ChoiceList,
} from "@shopify/polaris";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import AlertUndo from "../../products/edit/components/AlertUndo";
import useProductSyncStatus from "../../../hooks/useProductSyncStatus";
import { useShopTimezone } from "../../../hooks/useShopTimezone";
import { protectedApiPut } from "../../../api/protectedApiClient";
import { useLocaleFormatters } from "../../../hooks/useLocaleFormatters";
import TableErrorBoundary from "../../../components/Error/TableErrorBoundary";
import CellErrorBoundary from "../../../components/Error/CellErrorBoundary";
import JobProgressCell, { STATUS_CONFIG, normalizeJobStatus } from "./JobProgressCell";

const HISTORY_TABLE_MIN_HEIGHT = "560px";

function safeString(value, fallback = null, maxLength = 120) {
  if (value === undefined || value === null) return fallback;
  const stringValue = String(value).trim();
  if (!stringValue) return fallback;
  if (!Number.isFinite(maxLength) || maxLength <= 0) return stringValue;
  return stringValue.length > maxLength
    ? `${stringValue.slice(0, maxLength)}...`
    : stringValue;
}

function getHistoryRowId(item) {
  if (item?.id != null && String(item.id).trim() !== "") {
    return String(item.id);
  }

  const shop = String(item?.shop || "").trim();
  const title = String(item?.title || "").trim();
  const updatedAt = String(item?.updatedAt || "").trim();
  const status = String(item?.status || "").trim();
  return `derived:${shop}|${title}|${updatedAt}|${status}`;
}

const STATUS_LABEL_KEYS = {
  COMPLETED: { key: "jobStatus.completed", defaultValue: "Completed" },
  FAILED: { key: "jobStatus.failed", defaultValue: "Failed" },
  RUNNING: { key: "jobStatus.running", defaultValue: "Running" },
  QUEUED: { key: "jobStatus.queued", defaultValue: "Queued" },
  PENDING: { key: "jobStatus.pending", defaultValue: "Waiting to start" },
  CANCELLED: { key: "jobStatus.cancelled", defaultValue: "Cancelled" },
};

function getMerchantStatusKey(item) {
  return normalizeJobStatus(item);
}

function getJobTotalCount(item) {
  const candidates = [
    item?.totalCount,
    item?.totalItems,
    item?.progressSummary?.total,
  ];
  const positiveCount = candidates
    .map((value) => Number(value || 0))
    .find((value) => Number.isFinite(value) && value > 0);

  if (positiveCount !== undefined) return positiveCount;

  const fallbackCount = Number(candidates[0] || 0);
  return Number.isFinite(fallbackCount) && fallbackCount > 0 ? fallbackCount : 0;
}

function merchantStatusBadge(item, t) {
  const statusKey = getMerchantStatusKey(item);
  const config = STATUS_CONFIG[statusKey] || STATUS_CONFIG.RUNNING;
  const label = STATUS_LABEL_KEYS[statusKey] || STATUS_LABEL_KEYS.RUNNING;
  return (
    <Badge tone={config.tone}>
      {t(label.key, { defaultValue: label.defaultValue })}
    </Badge>
  );
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
  const queryClient = useQueryClient();
  const { dateTimeFormatter } = useLocaleFormatters();
  const { shopTimezone } = useShopTimezone();
  const { isSyncInProgress } = useProductSyncStatus();
  const [showUndoModal, setShowUndoModal] = useState(false);
  const [undoLoading, setUndoLoading] = useState(false);
  const [undoHistoryItem, setUndoHistoryItem] = useState(null);
  const [undoIdempotencyKey, setUndoIdempotencyKey] = useState(null);
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
    const operationId = safeString(history?.operationId || history?.id, "unknown", null);
    console.info("[undo-ui] button_click", {
      historyId: history?.id || null,
      operationId,
      status: history?.status || history?.primaryStatus?.key || null,
    });
    setUndoHistoryItem(history);
    setUndoIdempotencyKey(`undo:${operationId}`);
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

  const handleCloseUndoModal = useCallback(() => {
    setShowUndoModal(false);
    setUndoHistoryItem(null);
    setUndoIdempotencyKey(null);
  }, []);

  const handleUndoEditHistory = useCallback(async ({
    operationId,
    historyId,
    idempotencyKey,
  } = {}) => {
    const targetHistoryId = safeString(historyId || undoHistoryItem?.id, null, null);
    const targetOperationId = safeString(operationId || undoHistoryItem?.operationId || targetHistoryId, null, null);
    if (!targetHistoryId && !targetOperationId) return;
    setUndoLoading(true);
    try {
      console.info("[undo-ui] request_start", {
        historyId: targetHistoryId,
        operationId: targetOperationId,
      });
      await protectedApiPut(`/api/products/undo-edit/${targetHistoryId || targetOperationId}`, {
        operationId: targetOperationId,
        historyId: targetHistoryId,
      }, {
        idempotent: true,
        idempotencyKey,
      });
      console.info("[undo-ui] request_accepted", {
        historyId: targetHistoryId,
        operationId: targetOperationId,
      });
      await queryClient.invalidateQueries({ queryKey: ["history-list"] });
      await queryClient.invalidateQueries({ queryKey: ["edit-history-summary"] });
    } finally {
      setUndoLoading(false);
    }
  }, [queryClient, undoHistoryItem]);

  const undoSummary = useMemo(() => {
    if (!undoHistoryItem) return null;
    return {
      label:
        undoHistoryItem.editTypeLabel ||
        undoHistoryItem.title ||
        undoHistoryItem.label ||
        null,
      affectedProducts:
        undoHistoryItem.affectedProducts ??
        undoHistoryItem.productCount ??
        undoHistoryItem.processedCount ??
        null,
      affectedVariants:
        undoHistoryItem.affectedVariants ??
        undoHistoryItem.variantCount ??
        null,
      createdAt: undoHistoryItem.createdAt || undoHistoryItem.updatedAt || null,
      operationId: undoHistoryItem.operationId || undoHistoryItem.id || null,
      historyId: undoHistoryItem.id || null,
    };
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
                const id = getHistoryRowId(item);
                const totalCount = getJobTotalCount(item);
                const statusKey = getMerchantStatusKey(item);

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
                        {merchantStatusBadge(item, t)}
                      </CellErrorBoundary>
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <CellErrorBoundary fallback="[render error]">
                        <JobProgressCell
                          job={item}
                          processedCount={item?.processedCount || 0}
                          progressProcessedCount={item?.progressProcessedCount ?? item?.successCount ?? 0}
                          totalCount={totalCount}
                          status={statusKey}
                        />
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

      {showUndoModal ? (
        <AlertUndo
          show={showUndoModal}
          handleClose={handleCloseUndoModal}
          undoEditHistory={handleUndoEditHistory}
          loading={undoLoading}
          undoSummary={undoSummary}
          idempotencyKey={undoIdempotencyKey}
          shopTimezone={shopTimezone}
        />
      ) : null}
      </Box>
    </Card>
  );
});

HistoryTable.displayName = "HistoryTable";
export default HistoryTable;
