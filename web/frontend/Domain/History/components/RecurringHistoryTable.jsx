import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  IndexTable,
  IndexFilters,
  Badge,
  Button,
  ButtonGroup,
  Spinner,
  Box,
  Text,
  Modal,
  TextContainer,
  Pagination,
  EmptyState,
  Card,
  ChoiceList,
  BlockStack,
} from "@shopify/polaris";
import { useTranslation } from "react-i18next";
import RecurringEditViewModal from "./RecurringEditView";
import { recurringStatusBadge } from "../../shared/components/StatusBadge";
import { protectedApiDelete, protectedApiGet } from "../../../api/protectedApiClient";
import { useLocaleFormatters } from "../../../hooks/useLocaleFormatters";
import useDebouncedValue from "../../../hooks/useDebouncedValue";
import { useRecurringHistoryQuery } from "../hooks/useRecurringHistoryQuery";

const STATUS_OPTIONS = [
  { label: "recurringStatusActive", value: "active" },
  { label: "recurringStatusInactive", value: "inactive" },
  { label: "recurringStatusPaused", value: "paused" },
  { label: "recurringStatusCompleted", value: "completed" },
  { label: "recurringStatusFailed", value: "failed" },
  { label: "recurringStatusExpired", value: "expired" },
];

const FREQUENCY_OPTIONS = [
  { label: "recurringFrequencyHourly", value: "hourly" },
  { label: "recurringFrequencyEvery2Hours", value: "every 2 hours" },
  { label: "recurringFrequencyDaily", value: "daily" },
  { label: "recurringFrequencyWeekly", value: "weekly" },
  { label: "recurringFrequencyMonthly", value: "monthly" },
];

const DEFAULT_QUERY = {
  limit: 20,
  search: "",
  status: "",
  frequency: "",
  sortKey: "createdAt",
  sortDirection: "desc",
};

function getRecurringRowId(item) {
  if (item?.id != null && String(item.id).trim() !== "") {
    return String(item.id);
  }

  const title = String(item?.title || "").trim();
  const createdAt = String(item?.createdAt || "").trim();
  const frequency = String(item?.frequency || "").trim();
  const status = String(item?.status || "").trim();
  return `derived:${title}|${createdAt}|${frequency}|${status}`;
}

const RecurringRowActions = memo(function RecurringRowActions({
  rowId,
  rowItem,
  onView,
  onDelete,
  viewLabel,
  deleteLabel,
}) {
  return (
    <ButtonGroup>
      <Button size="slim" onClick={() => onView(rowId)}>{viewLabel}</Button>
      <Button
        size="slim"
        tone="critical"
        onClick={() => onDelete(rowItem)}
      >
        {deleteLabel}
      </Button>
    </ButtonGroup>
  );
});

const RecurringHistoryTable = memo(function RecurringHistoryTable({
  onRefresh,
  emptyStateMessage,
}) {
  const [open, setOpen] = useState(false);
  const [historyItem, setHistoryItem] = useState(null);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [detailsError, setDetailsError] = useState(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteRecurringItem, setDeleteRecurringItem] = useState(null);
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [cursorStack, setCursorStack] = useState([null]);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [searchDraft, setSearchDraft] = useState(DEFAULT_QUERY.search);
  const debouncedSearchDraft = useDebouncedValue(searchDraft, 400);
  const [pageInfo, setPageInfo] = useState({
    hasNextPage: false,
    hasPreviousPage: false,
    nextCursor: null,
    previousCursor: null,
  });
  const { t, i18n } = useTranslation(["history", "common"]);
  const queryClient = useQueryClient();
  const { dateTimeFormatter, numberFormatter } = useLocaleFormatters();
  const detailsRequestIdRef = useRef(0);
  const activeCursor = cursorStack[cursorIndex] || null;
  const recurringQuery = useRecurringHistoryQuery({
    query,
    cursor: activeCursor,
    lang: i18n.language || "en",
  });

  const items = recurringQuery.data?.items || recurringQuery.data?.data || [];
  const info = recurringQuery.data?.pageInfo || recurringQuery.data?.meta?.pageInfo || {};

  useEffect(() => {
    setPageInfo({
      hasNextPage: Boolean(info.hasNextPage),
      hasPreviousPage: cursorIndex > 0,
      nextCursor: info.nextCursor || info.endCursor || null,
      previousCursor: null,
    });
  }, [cursorIndex, info.endCursor, info.hasNextPage, info.nextCursor]);

  useEffect(() => {
    setCursorStack([null]);
    setCursorIndex(0);
    setQuery((current) => ({ ...current, search: debouncedSearchDraft }));
  }, [debouncedSearchDraft]);

  const appliedFilters = useMemo(() => {
    const filters = [];
    if (query.status) {
      filters.push({
        key: "status",
        label: t("recurringFilterStatusLabel", {
          value: query.status,
          defaultValue: `Status: ${query.status}`,
        }),
        onRemove: () => {
          setCursorStack([null]);
          setCursorIndex(0);
          setQuery((current) => ({ ...current, status: "" }));
        },
      });
    }
    if (query.frequency) {
      filters.push({
        key: "frequency",
        label: t("recurringFilterFrequencyLabel", {
          value: query.frequency,
          defaultValue: `Frequency: ${query.frequency}`,
        }),
        onRemove: () => {
          setCursorStack([null]);
          setCursorIndex(0);
          setQuery((current) => ({ ...current, frequency: "" }));
        },
      });
    }
    return filters;
  }, [query.status, query.frequency, t]);

  const filters = useMemo(
    () => [
      {
        key: "status",
        label: t("recurringFilterStatus", { defaultValue: "Status" }),
        filter: (
          <ChoiceList
            title={t("recurringFilterStatus", { defaultValue: "Status" })}
            titleHidden
            choices={STATUS_OPTIONS.map((option) => ({
              ...option,
              label: t(option.label, { defaultValue: option.value }),
            }))}
            selected={query.status ? [query.status] : []}
            onChange={(selected) => {
              setCursorStack([null]);
              setCursorIndex(0);
              setQuery((current) => ({ ...current, status: selected[0] || "" }));
            }}
          />
        ),
        shortcut: true,
      },
      {
        key: "frequency",
        label: t("recurringFilterFrequency", { defaultValue: "Frequency" }),
        filter: (
          <ChoiceList
            title={t("recurringFilterFrequency", { defaultValue: "Frequency" })}
            titleHidden
            choices={FREQUENCY_OPTIONS.map((option) => ({
              ...option,
              label: t(option.label, { defaultValue: option.value }),
            }))}
            selected={query.frequency ? [query.frequency] : []}
            onChange={(selected) => {
              setCursorStack([null]);
              setCursorIndex(0);
              setQuery((current) => ({ ...current, frequency: selected[0] || "" }));
            }}
          />
        ),
        shortcut: true,
      },
    ],
    [query.frequency, query.status, t],
  );

  const headings = useMemo(
    () => [
      { title: t("title") },
      { title: t("statusLabel") },
      { title: t("frequency") },
      { title: t("runs") },
      { title: t("created") },
      { title: t("actions") },
    ],
    [t],
  );

  const onViewDetails = useCallback(async (id) => {
    const requestId = detailsRequestIdRef.current + 1;
    detailsRequestIdRef.current = requestId;
    setIsLoadingDetails(true);
    setDetailsError(null);
    setHistoryItem(null);
    try {
      setOpen(true);
      const data = await protectedApiGet(`/api/products/recurring/detail/${id}?lang=${i18n.language}`);
      if (requestId !== detailsRequestIdRef.current) {
        return;
      }
      setHistoryItem(data.data);
    } catch (error) {
      if (requestId !== detailsRequestIdRef.current) {
        return;
      }
      setDetailsError(
        t("recurringDetailsLoadError", {
          defaultValue: "Failed to load recurring edit details",
        }),
      );
    } finally {
      if (requestId !== detailsRequestIdRef.current) {
        return;
      }
      setIsLoadingDetails(false);
    }
  }, [i18n.language, t]);
  const openDeleteModal = useCallback((item) => {
    setDeleteRecurringItem(item);
    setShowDeleteModal(true);
  }, []);

  const rows = useMemo(
    () =>
      items.map((item, index) => {
        const id = getRecurringRowId(item);
        return (
          <IndexTable.Row id={String(id)} key={String(id)} position={index}>
            <IndexTable.Cell>
              <Text as="span" variant="bodyMd">
                {item.title ||
                  t("recurringUntitled", { defaultValue: "Untitled" })}
              </Text>
            </IndexTable.Cell>
            <IndexTable.Cell>
              {recurringStatusBadge(
                item.status,
                t(item?.statusSummary?.labelKey || `statusRecurring.${String(item.status || "").toLowerCase()}`, {
                  defaultValue: item?.statusSummary?.defaultLabel || item.status || "Unknown",
                }),
              )}
            </IndexTable.Cell>
            <IndexTable.Cell>
              <Badge tone="info">
                {t(item?.frequencySummary?.labelKey || `frequencyRecurring.${String(item.frequency || "").toLowerCase()}`, {
                  defaultValue: item?.frequencySummary?.defaultLabel || item.frequency || "-",
                })}
              </Badge>
            </IndexTable.Cell>
            <IndexTable.Cell>
              {`${numberFormatter.format(item.successfulRuns || 0)} / ${numberFormatter.format(item.totalRuns || 0)}`}
            </IndexTable.Cell>
            <IndexTable.Cell>{item.createdAt ? dateTimeFormatter.format(new Date(item.createdAt)) : "-"}</IndexTable.Cell>
            <IndexTable.Cell>
              <RecurringRowActions
                rowId={id}
                rowItem={item}
                onView={onViewDetails}
                onDelete={openDeleteModal}
                viewLabel={t("view")}
                deleteLabel={t("delete")}
              />
            </IndexTable.Cell>
          </IndexTable.Row>
        );
      }),
    [items, t, numberFormatter, dateTimeFormatter, onViewDetails, openDeleteModal],
  );

  const handleDeleteRecurring = useCallback(async () => {
    if (!deleteRecurringItem?.id) return;
    setDeleteLoading(true);
    try {
      await protectedApiDelete(`/api/products/delete-recurring-edit/${deleteRecurringItem.id}`, {
        idempotent: true,
      });
      await queryClient.invalidateQueries({ queryKey: ["recurring-history-list"] });
      setShowDeleteModal(false);
    } finally {
      setDeleteLoading(false);
    }
  }, [deleteRecurringItem, queryClient]);

  if (recurringQuery.isLoading) {
    return (
      <Box padding="400" textAlign="center">
        <Spinner
          accessibilityLabel={t("recurringLoadingAriaLabel", {
            defaultValue: "Loading recurring edits",
          })}
          size="large"
        />
      </Box>
    );
  }

  return (
    <>
      <Card padding="0">
        <IndexFilters
          queryValue={searchDraft}
          queryPlaceholder={t("recurringSearchPlaceholder", {
            defaultValue: "Search recurring edits",
          })}
          onQueryChange={setSearchDraft}
          onQueryClear={() => {
            setSearchDraft("");
            setCursorStack([null]);
            setCursorIndex(0);
            setQuery((current) => ({ ...current, search: "", status: "", frequency: "" }));
          }}
          filters={filters}
          appliedFilters={appliedFilters}
          onClearAll={() => {
            setSearchDraft("");
            setCursorStack([null]);
            setCursorIndex(0);
            setQuery((current) => ({ ...current, search: "", status: "", frequency: "" }));
          }}
          cancelAction={{ onAction: () => {}, disabled: true, loading: false }}
          tabs={[]}
          selected={0}
          onSelect={() => {}}
          canCreateNewView={false}
          mode="default"
          setMode={() => {}}
        />

        {items.length === 0 ? (
          <Box padding="600">
            <EmptyState heading={t("historyEmptyStateTitle")}>
              <p>
                {emptyStateMessage ||
                  t("recurringEmptyStateMessage", {
                    defaultValue: "No recurring edits found.",
                  })}
              </p>
            </EmptyState>
          </Box>
        ) : (
          <>
            <Box paddingInlineStart="800">
              <IndexTable
                resourceName={{ singular: "recurring edit", plural: "recurring edits" }}
                itemCount={items.length}
                selectable={false}
                headings={headings}
              >
                {rows}
              </IndexTable>
            </Box>

            <Box padding="400">
              <BlockStack gap="200">
                <Pagination
                  hasNext={pageInfo.hasNextPage}
                  hasPrevious={pageInfo.hasPreviousPage}
                  onNext={() => {
                    if (!pageInfo.nextCursor) return;
                    setCursorStack((prev) => [...prev.slice(0, cursorIndex + 1), pageInfo.nextCursor]);
                    setCursorIndex((prev) => prev + 1);
                  }}
                  onPrevious={() => {
                    setCursorIndex((prev) => Math.max(0, prev - 1));
                  }}
                />
              </BlockStack>
            </Box>
          </>
        )}
      </Card>

      <RecurringEditViewModal
        data={historyItem}
        error={detailsError}
        isLoading={isLoadingDetails}
        open={open}
        onClose={() => setOpen(false)}
        onUpdated={onRefresh}
      />

      <Modal
        open={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        title={t("deleteRecurringEdit")}
        primaryAction={{ content: t("delete"), onAction: handleDeleteRecurring, loading: deleteLoading, destructive: true }}
        secondaryActions={[{ content: t("cancel"), onAction: () => setShowDeleteModal(false) }]}
      >
        <Modal.Section>
          <TextContainer>
            <p>{t("deleteRecurringConfirmation", { title: deleteRecurringItem?.title || "" })}</p>
          </TextContainer>
        </Modal.Section>
      </Modal>
    </>
  );
});

RecurringHistoryTable.displayName = "RecurringHistoryTable";
export default RecurringHistoryTable;
