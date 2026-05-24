import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
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

const STATUS_OPTIONS = [
  { label: "Active", value: "active" },
  { label: "Inactive", value: "inactive" },
  { label: "Paused", value: "paused" },
  { label: "Completed", value: "completed" },
  { label: "Failed", value: "failed" },
  { label: "Expired", value: "expired" },
];

const FREQUENCY_OPTIONS = [
  { label: "Hourly", value: "hourly" },
  { label: "Every 2 Hours", value: "every 2 hours" },
  { label: "Daily", value: "daily" },
  { label: "Weekly", value: "weekly" },
  { label: "Monthly", value: "monthly" },
];

const DEFAULT_QUERY = {
  cursor: null,
  limit: 20,
  search: "",
  status: "",
  frequency: "",
  sortKey: "createdAt",
  sortDirection: "desc",
};

const RecurringHistoryTable = memo(function RecurringHistoryTable({
  onRefresh,
  emptyStateMessage = "No recurring edits found.",
}) {
  const [open, setOpen] = useState(false);
  const [historyItem, setHistoryItem] = useState(null);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [detailsError, setDetailsError] = useState(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteRecurringItem, setDeleteRecurringItem] = useState(null);
  const [items, setItems] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [pageInfo, setPageInfo] = useState({
    hasNextPage: false,
    hasPreviousPage: false,
    nextCursor: null,
    previousCursor: null,
  });
  const { t, i18n } = useTranslation();

  const fetchRecurring = useCallback(async (nextQuery) => {
    try {
      setIsLoading(true);
      const params = new URLSearchParams();
      Object.entries({ ...nextQuery, lang: i18n.language || "en" }).forEach(([key, value]) => {
        if (value == null || value === "") return;
        params.set(key, String(value));
      });
      const response = await fetch(`/api/products/get-recurring-edits?${params.toString()}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message || "Failed to fetch recurring edits");

      const nextItems = payload.items || payload.data || [];
      const info = payload.pageInfo || payload.meta?.pageInfo || {};
      setItems(nextItems);
      setPageInfo({
        hasNextPage: Boolean(info.hasNextPage),
        hasPreviousPage: Boolean(info.hasPreviousPage),
        nextCursor: info.nextCursor || info.endCursor || null,
        previousCursor: info.previousCursor || null,
      });
    } finally {
      setIsLoading(false);
    }
  }, [i18n.language]);

  useEffect(() => {
    fetchRecurring(query);
  }, [query, fetchRecurring]);

  const appliedFilters = useMemo(() => {
    const filters = [];
    if (query.status) {
      filters.push({
        key: "status",
        label: `Status: ${query.status}`,
        onRemove: () => setQuery((current) => ({ ...current, status: "", cursor: null })),
      });
    }
    if (query.frequency) {
      filters.push({
        key: "frequency",
        label: `Frequency: ${query.frequency}`,
        onRemove: () => setQuery((current) => ({ ...current, frequency: "", cursor: null })),
      });
    }
    return filters;
  }, [query.status, query.frequency]);

  const onViewDetails = async (id) => {
    setIsLoadingDetails(true);
    setDetailsError(null);
    setHistoryItem(null);
    try {
      setOpen(true);
      const response = await fetch(`/api/products/get-recurring-edit/${id}?lang=${i18n.language}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message);
      setHistoryItem(data.data);
    } catch (error) {
      setDetailsError(error.message || "Failed to load recurring edit details");
    } finally {
      setIsLoadingDetails(false);
    }
  };

  const handleDeleteRecurring = useCallback(async () => {
    if (!deleteRecurringItem?.id) return;
    setDeleteLoading(true);
    try {
      const response = await fetch(`/api/products/delete-recurring-edit/${deleteRecurringItem.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });
      if (response.ok) {
        setShowDeleteModal(false);
        fetchRecurring(query);
      }
    } finally {
      setDeleteLoading(false);
    }
  }, [deleteRecurringItem, fetchRecurring, query]);

  if (isLoading) {
    return (
      <Box padding="400" textAlign="center">
        <Spinner accessibilityLabel="Loading recurring edits" size="large" />
      </Box>
    );
  }

  return (
    <>
      <Card padding="0">
        <IndexFilters
          queryValue={query.search}
          queryPlaceholder="Search recurring edits"
          onQueryChange={(value) => setQuery((current) => ({ ...current, search: value, cursor: null }))}
          onQueryClear={() => setQuery((current) => ({ ...current, search: "", status: "", frequency: "", cursor: null }))}
          filters={[
            {
              key: "status",
              label: "Status",
              filter: (
                <ChoiceList
                  title="Status"
                  titleHidden
                  choices={STATUS_OPTIONS}
                  selected={query.status ? [query.status] : []}
                  onChange={(selected) => setQuery((current) => ({ ...current, status: selected[0] || "", cursor: null }))}
                />
              ),
              shortcut: true,
            },
            {
              key: "frequency",
              label: "Frequency",
              filter: (
                <ChoiceList
                  title="Frequency"
                  titleHidden
                  choices={FREQUENCY_OPTIONS}
                  selected={query.frequency ? [query.frequency] : []}
                  onChange={(selected) => setQuery((current) => ({ ...current, frequency: selected[0] || "", cursor: null }))}
                />
              ),
              shortcut: true,
            },
          ]}
          appliedFilters={appliedFilters}
          onClearAll={() => setQuery((current) => ({ ...current, search: "", status: "", frequency: "", cursor: null }))}
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
              <p>{emptyStateMessage}</p>
            </EmptyState>
          </Box>
        ) : (
          <>
            <Box paddingInlineStart="800">
              <IndexTable
                resourceName={{ singular: "recurring edit", plural: "recurring edits" }}
                itemCount={items.length}
                selectable={false}
                headings={[
                  { title: t("title") },
                  { title: t("statusLabel") },
                  { title: t("frequency") },
                  { title: t("runs") },
                  { title: t("created") },
                  { title: t("actions") },
                ]}
              >
                {items.map((item, index) => {
                  const id = item._id || item.id || `rec-${index}`;
                  return (
                    <IndexTable.Row id={String(id)} key={String(id)} position={index}>
                      <IndexTable.Cell>
                        <Text as="span" variant="bodyMd">{item.title || "Untitled"}</Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {recurringStatusBadge(item.status, t(`statusRecurring.${String(item.status || "").toLowerCase()}`, { defaultValue: item.status || "Unknown" }))}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Badge tone="info">{t(`frequencyRecurring.${String(item.frequency || "").toLowerCase()}`, { defaultValue: item.frequency || "-" })}</Badge>
                      </IndexTable.Cell>
                      <IndexTable.Cell>{`${item.successfulRuns || 0} / ${item.totalRuns || 0}`}</IndexTable.Cell>
                      <IndexTable.Cell>{item.createdAt ? new Date(item.createdAt).toLocaleString() : "-"}</IndexTable.Cell>
                      <IndexTable.Cell>
                        <ButtonGroup>
                          <Button size="slim" onClick={() => onViewDetails(id)}>{t("view")}</Button>
                          <Button
                            size="slim"
                            tone="critical"
                            onClick={() => {
                              setDeleteRecurringItem(item);
                              setShowDeleteModal(true);
                            }}
                          >
                            {t("delete")}
                          </Button>
                        </ButtonGroup>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  );
                })}
              </IndexTable>
            </Box>

            <Box padding="400">
              <BlockStack gap="200">
                <Pagination
                  hasNext={pageInfo.hasNextPage}
                  hasPrevious={pageInfo.hasPreviousPage}
                  onNext={() => setQuery((current) => ({ ...current, cursor: pageInfo.nextCursor || null }))}
                  onPrevious={() => setQuery((current) => ({ ...current, cursor: pageInfo.previousCursor || null }))}
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
