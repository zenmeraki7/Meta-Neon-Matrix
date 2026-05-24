import React, { useMemo, useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  Modal,
  FormLayout,
  TextField,
  Select,
  Banner,
  Checkbox,
  BlockStack,
  InlineStack,
  Text,
} from "@shopify/polaris";

import { useTranslation } from "react-i18next";
import { buildFilterAstFromLegacyFilters } from "../../list/utils/filterAst.js";
import { useApiClient } from "../../../../hooks/useApiClient";
import { toSafeErrorMessage } from "../../../../utils/frontendError";
import { useShopTimezone } from "../../../../hooks/useShopTimezone";
import { getDateInputInTimezone, zonedDateTimeToUtcIso } from "../../../../utils/timezoneDateTime";
import { useToast as useAppToast } from "../../../../components/providers/ToastProvider";

const FREQUENCY_OPTIONS = [
  { label: "Hourly", value: "Hourly" },
  { label: "Every 2 Hours", value: "Every 2 Hours" },
  { label: "Daily", value: "Daily" },
  { label: "Weekly", value: "Weekly" },
  { label: "Monthly", value: "Monthly" },
];

const DAYS_OF_WEEK = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function getDefaultTitle(editedField, editedBy, t) {
  const safeField = editedField
    ? t(`recurringEditFields.${editedField}`, { defaultValue: editedField })
    : t("recurringEditDefaultField");

  const safeEditType = editedBy
    ? t(`recurringEditEditTypes.${editedBy}`, { defaultValue: editedBy })
    : t("recurringEditDefaultEditType");

  return `${safeField} ${t("recurringEditDefaultTitleConnector")} ${safeEditType}`;
}

function RecurringEditModal({
  show,
  onHide,
  count,
  editedField,
  editedBy,
  value,
  searchKey,
  replaceText,
  location,
  filters,
  supportValue,
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const api = useApiClient();
  const { shopTimezone } = useShopTimezone();
  const resolvedTimezone = shopTimezone || "UTC";
  const { showSuccess, showError } = useAppToast();

  const dayOfMonthOptions = useMemo(
    () =>
      Array.from({ length: 31 }, (_, index) => ({
        label: String(index + 1),
        value: String(index + 1),
      })),
    [],
  );

  const [title, setTitle] = useState(() =>
    getDefaultTitle(editedField, editedBy, t),
  );
  const [frequency, setFrequency] = useState("Daily");
  const [timeToRun, setTimeToRun] = useState("12:00");
  const [dayOfMonthToRun, setDayOfMonthToRun] = useState("1");
  const [daysOfWeekToRun, setDaysOfWeekToRun] = useState([]);
  const [hasStartAt, setHasStartAt] = useState(false);
  const [startDate, setStartDate] = useState(getDateInputInTimezone(shopTimezone || "UTC"));
  const [startTime, setStartTime] = useState("12:00");
  const [hasEndAt, setHasEndAt] = useState(false);
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("12:00");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [upgradeWarning, setUpgradeWarning] = useState("");

  useEffect(() => {
    setStartDate((current) => current || getDateInputInTimezone(shopTimezone || "UTC"));
  }, [shopTimezone]);

  const resetForm = useCallback(() => {
    setTitle(getDefaultTitle(editedField, editedBy, t));
    setFrequency("Daily");
    setTimeToRun("12:00");
    setDayOfMonthToRun("1");
    setDaysOfWeekToRun([]);
    setHasStartAt(false);
    setStartDate(getDateInputInTimezone(shopTimezone || "UTC"));
    setStartTime("12:00");
    setHasEndAt(false);
    setEndDate("");
    setEndTime("12:00");
    setSubmitting(false);
    setError("");
    setUpgradeWarning("");
  }, [editedBy, editedField, shopTimezone, t]);

  const handleClose = useCallback(() => {
    resetForm();
    onHide();
  }, [onHide, resetForm]);

  const handleWeekdayChange = useCallback((day, checked) => {
    setDaysOfWeekToRun((current) => {
      if (checked) {
        return current.includes(day) ? current : [...current, day];
      }

      return current.filter((item) => item !== day);
    });
  }, []);

  const requiresTime =
    frequency === "Daily" || frequency === "Weekly" || frequency === "Monthly";
  const needsWeekdaySelection = frequency === "Weekly";
  const needsDayOfMonthSelection = frequency === "Monthly";

  const validate = useCallback(() => {
    if (!title.trim()) {
      return t("recurringEditErrors.titleRequired");


    }

    if (needsWeekdaySelection && daysOfWeekToRun.length === 0) {
      return t("recurringEditErrors.weekdayRequired");

    }

    if (hasStartAt && !startDate) {
      return t("recurringEditErrors.startDateRequired");
    }

    if (hasEndAt && !endDate) {
      return t("recurringEditErrors.endDateRequired");

    }

    const startAt = hasStartAt
      ? zonedDateTimeToUtcIso(startDate, startTime, resolvedTimezone)
      : null;
    const endAt = hasEndAt ? zonedDateTimeToUtcIso(endDate, endTime, resolvedTimezone) : null;

    if (startAt && endAt && new Date(startAt) >= new Date(endAt)) {
      return t("recurringEditErrors.endAfterStart");
    }

    return "";
  }, [
    daysOfWeekToRun.length,
    endDate,
    endTime,
    hasEndAt,
    hasStartAt,
    needsWeekdaySelection,
    startDate,
    startTime,
    resolvedTimezone,
    title,
  ]);

  const handleSubmit = useCallback(async () => {
    const validationMessage = validate();
    if (validationMessage) {
      setError(validationMessage);
      return;
    }

    setSubmitting(true);
    setError("");
    setUpgradeWarning("");

    try {
      const payload = {
        title: title.trim(),
        frequency,
        timezone: resolvedTimezone,
        filterParams: filters,
        filterAst: buildFilterAstFromLegacyFilters({
          filterParams: filters,
          targetGranularity: "PRODUCT",
          source: "RECURRING_DEFINITION",
        }),
        editedField,
        editedBy,
        value,
        searchKey,
        replaceText,
        supportValue,
        locationId: location || null,
        status: "Active",
      };

      if (requiresTime) {
        payload.timeToRun = timeToRun;
      }

      if (needsWeekdaySelection) {
        payload.daysOfWeekToRun = daysOfWeekToRun;
      }

      if (needsDayOfMonthSelection) {
        payload.dayOfMonthToRun = Number.parseInt(dayOfMonthToRun, 10);
      }

      if (hasStartAt) {
        payload.startAt = zonedDateTimeToUtcIso(startDate, startTime, resolvedTimezone);
      }

      if (hasEndAt) {
        payload.endAt = zonedDateTimeToUtcIso(endDate, endTime, resolvedTimezone);
      }

      await api.post("/api/products/create-recurring-edit", payload, {
        idempotent: true,
      });

      showSuccess(t("recurringEditSuccess.created"));

      setTimeout(() => {
        handleClose();
        navigate("/history");
      }, 800);
    } catch (requestError) {
      const detail = requestError?.details || null;
      const message = toSafeErrorMessage(requestError, t("recurringEditErrors.createFailed"));
      if (detail?.code === "UPGRADE_REQUIRED" || (typeof message === "string" && message.toLowerCase().includes("pro"))) {
        setUpgradeWarning(message);
        setSubmitting(false);
        return;
      }
      setError(message);
      showError(message);
    } finally {
      setSubmitting(false);
    }
  }, [
    dayOfMonthToRun,
    daysOfWeekToRun,
    editedBy,
    editedField,
    filters,
    frequency,
    handleClose,
    hasEndAt,
    hasStartAt,
    location,
    navigate,
    needsDayOfMonthSelection,
    needsWeekdaySelection,
    replaceText,
    requiresTime,
    searchKey,
    startDate,
    startTime,
    endDate,
    endTime,
    supportValue,
    timeToRun,
    resolvedTimezone,
    title,
    validate,
    value,
    api,
    showError,
    showSuccess,
  ]);

  return (
    <>
      <Modal
        open={show}
        onClose={handleClose}
        title={t("recurringEditModalTitle")}
        primaryAction={{
          content: t("recurringEditSaveButton"),
          onAction: handleSubmit,
          loading: submitting,
          disabled: submitting,
        }}
        secondaryActions={[
          {
            content: t("commonCancelButton"),
            onAction: handleClose,
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            {upgradeWarning && (
              <Banner
                tone="warning"
                title={t("recurringEditUpgradeRequired")}
                onDismiss={() => setUpgradeWarning("")}
                action={{
                  content: t("recurringEditUpgradePlan"),
                  onAction: () => navigate("/pricing"),
                }}
              >
                <p>{upgradeWarning}</p>
              </Banner>
            )}

            {error && (
              <Banner tone="critical" onDismiss={() => setError("")}>
                <p>{error}</p>
              </Banner>
            )}

            <Banner tone="info">
              <p>
                {t("recurringEditDescriptionPrefix")} <strong>{count}</strong>{" "}
                {t("recurringEditDescriptionSuffix")}
              </p>
            </Banner>

            <FormLayout>
              <TextField
                label={t("recurringEditTitleLabel")}
                value={title}
                onChange={setTitle}
                autoComplete="off"
                placeholder={t("recurringEditTitlePlaceholder")}
              />

              <FormLayout.Group>
                <Select
                  label={t("recurringEditFrequencyLabel")}
                  options={FREQUENCY_OPTIONS.map((opt) => ({
                    ...opt,
                    label: t(`recurringEditFrequencyOptions.${opt.value}`),
                  }))}
                  value={frequency}
                  onChange={setFrequency}
                />
              </FormLayout.Group>

              <Banner tone="info">
                <p>All recurring schedule times are interpreted in shop timezone: <strong>{resolvedTimezone}</strong>.</p>
              </Banner>

              {requiresTime && (
                <TextField
                  label={t("recurringEditTimeLabel")}
                  type="time"
                  value={timeToRun}
                  onChange={setTimeToRun}
                  helpText={t("recurringEditTimeHelpText")}
                />  
              )}

              {needsWeekdaySelection && (
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                    {t("recurringEditDaysOfWeekLabel")}
                  </Text>
                  <InlineStack gap="300" wrap>
                    {DAYS_OF_WEEK.map((day) => (
                      <Checkbox
                        key={day}
                        label={t(`weekdays.${day}`)}
                        checked={daysOfWeekToRun.includes(day)}
                        onChange={(checked) => handleWeekdayChange(day, checked)}
                      />
                    ))}
                  </InlineStack>
                </BlockStack>
              )}

              {needsDayOfMonthSelection && (
                <Select
                  label={t("recurringEditDayOfMonthLabel")}
                  options={dayOfMonthOptions}
                  value={dayOfMonthToRun}
                  onChange={setDayOfMonthToRun}
                  helpText={t("recurringEditDayOfMonthHelpText")}
                />
              )}

              <Checkbox
                label={t("recurringEditStartSpecificDateLabel")}
                checked={hasStartAt}
                onChange={(checked) => setHasStartAt(checked)}
              />

              {hasStartAt && (
                <FormLayout.Group>
                  <TextField
                    label={t("recurringEditStartDateLabel")}
                    type="date"
                    value={startDate}
                    onChange={setStartDate}
                    min={getDateInputInTimezone(resolvedTimezone)}
                  />
                  <TextField
                    label={t("recurringEditStartTimeLabel")}
                    type="time"
                    value={startTime}
                    onChange={setStartTime}
                  />
                </FormLayout.Group>
              )}

              <Checkbox
                label={t("recurringEditStopAfterDateLabel")}
                checked={hasEndAt}
                onChange={(checked) => setHasEndAt(checked)}
              />

              {hasEndAt && (
                <FormLayout.Group>
                  <TextField
                    label={t("recurringEditEndDateLabel")}
                    type="date"
                    value={endDate}
                    onChange={setEndDate}
                    min={startDate || getDateInputInTimezone(resolvedTimezone)}
                  />
                  <TextField
                    label={t("recurringEditEndTimeLabel")}
                    type="time"
                    value={endTime}
                    onChange={setEndTime}
                  />
                </FormLayout.Group>
              )}
            </FormLayout>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </>
  );
}

export default React.memo(RecurringEditModal);
