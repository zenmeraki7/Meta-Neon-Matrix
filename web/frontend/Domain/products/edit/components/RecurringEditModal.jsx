import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
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
import { useShopTimezone } from "../../../../hooks/useShopTimezone";
import {
  getDateInputInTimezone,
  zonedDateTimeToUtcIso,
} from "../../../../utils/timezoneDateTime";
import { useToast as useAppToast } from "../../../../components/providers/ToastProvider";
import {
  mapCreateRecurringEditError,
  useCreateRecurringEditMutation,
} from "../hooks/useCreateRecurringEditMutation";

const DEFAULT_FREQUENCY = "Daily";
const DEFAULT_TIME = "12:00";
const DEFAULT_DAY_OF_MONTH = "1";
const ACTIVE_STATUS = "Active";
const FALLBACK_TIMEZONE = "UTC";

const FREQUENCY_OPTIONS = Object.freeze([
  {
    labelKey: "recurringEditFrequencyOptions.Hourly",
    label: "Hourly",
    value: "Hourly",
  },
  {
    labelKey: "recurringEditFrequencyOptions.Every 2 Hours",
    label: "Every 2 Hours",
    value: "Every 2 Hours",
  },
  {
    labelKey: "recurringEditFrequencyOptions.Daily",
    label: "Daily",
    value: "Daily",
  },
  {
    labelKey: "recurringEditFrequencyOptions.Weekly",
    label: "Weekly",
    value: "Weekly",
  },
  {
    labelKey: "recurringEditFrequencyOptions.Monthly",
    label: "Monthly",
    value: "Monthly",
  },
]);

const DAYS_OF_WEEK = Object.freeze([
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]);

function safeString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;

  const stringValue = String(value).trim();

  return stringValue || fallback;
}

function safeCount(value) {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue) || numberValue < 0) {
    return 0;
  }

  return Math.floor(numberValue);
}

function createSubmissionKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `recurring-edit:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2)}`;
}

function isValidTime(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ""));
}

function getDefaultTitle(editedField, editedBy, t) {
  const safeField = editedField
    ? t(`recurringEditFields.${editedField}`, {
        defaultValue: editedField,
      })
    : t("recurringEditDefaultField", {
        defaultValue: "Field",
      });

  const safeEditType = editedBy
    ? t(`recurringEditEditTypes.${editedBy}`, {
        defaultValue: editedBy,
      })
    : t("recurringEditDefaultEditType", {
        defaultValue: "edit",
      });

  return `${safeField} ${t("recurringEditDefaultTitleConnector", {
    defaultValue: "by",
  })} ${safeEditType}`;
}

function buildInitialFormState({ editedField, editedBy, timezone, t }) {
  return {
    title: getDefaultTitle(editedField, editedBy, t),
    frequency: DEFAULT_FREQUENCY,
    timeToRun: DEFAULT_TIME,
    dayOfMonthToRun: DEFAULT_DAY_OF_MONTH,
    daysOfWeekToRun: [],
    hasStartAt: false,
    startDate: getDateInputInTimezone(timezone),
    startTime: DEFAULT_TIME,
    hasEndAt: false,
    endDate: "",
    endTime: DEFAULT_TIME,
  };
}

function frequencyRequiresTime(frequency) {
  return (
    frequency === "Daily" ||
    frequency === "Weekly" ||
    frequency === "Monthly"
  );
}

function frequencyNeedsWeekdaySelection(frequency) {
  return frequency === "Weekly";
}

function frequencyNeedsDayOfMonthSelection(frequency) {
  return frequency === "Monthly";
}

function buildRecurringEditPayload({
  title,
  frequency,
  resolvedTimezone,
  filters,
  editedField,
  editedBy,
  value,
  searchKey,
  replaceText,
  supportValue,
  location,
  requiresTime,
  timeToRun,
  needsWeekdaySelection,
  daysOfWeekToRun,
  needsDayOfMonthSelection,
  dayOfMonthToRun,
  hasStartAt,
  startDate,
  startTime,
  hasEndAt,
  endDate,
  endTime,
}) {
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
    locationId: safeString(location, null),
    status: ACTIVE_STATUS,
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
    payload.startAt = zonedDateTimeToUtcIso(
      startDate,
      startTime,
      resolvedTimezone
    );
  }

  if (hasEndAt) {
    payload.endAt = zonedDateTimeToUtcIso(
      endDate,
      endTime,
      resolvedTimezone
    );
  }

  return payload;
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
  const { shopTimezone } = useShopTimezone();
  const { showSuccess, showError } = useAppToast();
  const createRecurringEditMutation = useCreateRecurringEditMutation();

  const resolvedTimezone = shopTimezone || FALLBACK_TIMEZONE;
  const safeProductCount = safeCount(count);
  const submitting = createRecurringEditMutation.isPending;

  const [submissionKey, setSubmissionKey] = useState(createSubmissionKey);

  const initialFormState = useMemo(
    () =>
      buildInitialFormState({
        editedField,
        editedBy,
        timezone: resolvedTimezone,
        t,
      }),
    [editedBy, editedField, resolvedTimezone, t]
  );

  const [title, setTitle] = useState(initialFormState.title);
  const [frequency, setFrequency] = useState(initialFormState.frequency);
  const [timeToRun, setTimeToRun] = useState(initialFormState.timeToRun);
  const [dayOfMonthToRun, setDayOfMonthToRun] = useState(
    initialFormState.dayOfMonthToRun
  );
  const [daysOfWeekToRun, setDaysOfWeekToRun] = useState(
    initialFormState.daysOfWeekToRun
  );
  const [hasStartAt, setHasStartAt] = useState(initialFormState.hasStartAt);
  const [startDate, setStartDate] = useState(initialFormState.startDate);
  const [startTime, setStartTime] = useState(initialFormState.startTime);
  const [hasEndAt, setHasEndAt] = useState(initialFormState.hasEndAt);
  const [endDate, setEndDate] = useState(initialFormState.endDate);
  const [endTime, setEndTime] = useState(initialFormState.endTime);

  const [error, setError] = useState("");
  const [upgradeWarning, setUpgradeWarning] = useState("");

  const dayOfMonthOptions = useMemo(
    () =>
      Array.from({ length: 31 }, (_, index) => ({
        label: String(index + 1),
        value: String(index + 1),
      })),
    []
  );

  const translatedFrequencyOptions = useMemo(
    () =>
      FREQUENCY_OPTIONS.map((option) => ({
        label: t(option.labelKey, {
          defaultValue: option.label,
        }),
        value: option.value,
      })),
    [t]
  );

  const requiresTime = frequencyRequiresTime(frequency);
  const needsWeekdaySelection = frequencyNeedsWeekdaySelection(frequency);
  const needsDayOfMonthSelection = frequencyNeedsDayOfMonthSelection(frequency);

  const startDateMin = useMemo(
    () => getDateInputInTimezone(resolvedTimezone),
    [resolvedTimezone]
  );

  const endDateMin = startDate || startDateMin;

  const resetForm = useCallback(() => {
    setTitle(initialFormState.title);
    setFrequency(initialFormState.frequency);
    setTimeToRun(initialFormState.timeToRun);
    setDayOfMonthToRun(initialFormState.dayOfMonthToRun);
    setDaysOfWeekToRun(initialFormState.daysOfWeekToRun);
    setHasStartAt(initialFormState.hasStartAt);
    setStartDate(initialFormState.startDate);
    setStartTime(initialFormState.startTime);
    setHasEndAt(initialFormState.hasEndAt);
    setEndDate(initialFormState.endDate);
    setEndTime(initialFormState.endTime);
    setError("");
    setUpgradeWarning("");
    setSubmissionKey(createSubmissionKey());
    createRecurringEditMutation.reset();
  }, [createRecurringEditMutation, initialFormState]);

  useEffect(() => {
    if (!show) {
      resetForm();
    }
  }, [resetForm, show]);

  useEffect(() => {
    if (!show) return;

    setStartDate((current) => {
      return current || getDateInputInTimezone(resolvedTimezone);
    });
  }, [resolvedTimezone, show]);

  const handleClose = useCallback(() => {
    if (submitting) return;

    resetForm();

    if (typeof onHide === "function") {
      onHide();
    }
  }, [onHide, resetForm, submitting]);

  const handleWeekdayChange = useCallback((day, checked) => {
    setDaysOfWeekToRun((current) => {
      if (checked) {
        return current.includes(day) ? current : [...current, day];
      }

      return current.filter((item) => item !== day);
    });
  }, []);

  const validate = useCallback(() => {
    const trimmedTitle = title.trim();

    if (!trimmedTitle) {
      return t("recurringEditErrors.titleRequired", {
        defaultValue: "Title is required.",
      });
    }

    if (requiresTime && !isValidTime(timeToRun)) {
      return t("recurringEditErrors.timeRequired", {
        defaultValue: "Enter a valid time.",
      });
    }

    if (needsWeekdaySelection && daysOfWeekToRun.length === 0) {
      return t("recurringEditErrors.weekdayRequired", {
        defaultValue: "Select at least one weekday.",
      });
    }

    if (hasStartAt && !startDate) {
      return t("recurringEditErrors.startDateRequired", {
        defaultValue: "Start date is required.",
      });
    }

    if (hasStartAt && !isValidTime(startTime)) {
      return t("recurringEditErrors.startTimeRequired", {
        defaultValue: "Enter a valid start time.",
      });
    }

    if (hasEndAt && !endDate) {
      return t("recurringEditErrors.endDateRequired", {
        defaultValue: "End date is required.",
      });
    }

    if (hasEndAt && !isValidTime(endTime)) {
      return t("recurringEditErrors.endTimeRequired", {
        defaultValue: "Enter a valid end time.",
      });
    }

    const startAt = hasStartAt
      ? zonedDateTimeToUtcIso(startDate, startTime, resolvedTimezone)
      : null;

    const endAt = hasEndAt
      ? zonedDateTimeToUtcIso(endDate, endTime, resolvedTimezone)
      : null;

    if (startAt && endAt && new Date(startAt) >= new Date(endAt)) {
      return t("recurringEditErrors.endAfterStart", {
        defaultValue: "End date must be after start date.",
      });
    }

    return "";
  }, [
    daysOfWeekToRun.length,
    endDate,
    endTime,
    hasEndAt,
    hasStartAt,
    needsWeekdaySelection,
    requiresTime,
    resolvedTimezone,
    startDate,
    startTime,
    timeToRun,
    title,
    t,
  ]);

  const buildSubmitPayload = useCallback(() => {
    return buildRecurringEditPayload({
      title,
      frequency,
      resolvedTimezone,
      filters,
      editedField,
      editedBy,
      value,
      searchKey,
      replaceText,
      supportValue,
      location,
      requiresTime,
      timeToRun,
      needsWeekdaySelection,
      daysOfWeekToRun,
      needsDayOfMonthSelection,
      dayOfMonthToRun,
      hasStartAt,
      startDate,
      startTime,
      hasEndAt,
      endDate,
      endTime,
    });
  }, [
    dayOfMonthToRun,
    daysOfWeekToRun,
    editedBy,
    editedField,
    endDate,
    endTime,
    filters,
    frequency,
    hasEndAt,
    hasStartAt,
    location,
    needsDayOfMonthSelection,
    needsWeekdaySelection,
    replaceText,
    requiresTime,
    resolvedTimezone,
    searchKey,
    startDate,
    startTime,
    supportValue,
    timeToRun,
    title,
    value,
  ]);

  const handleSubmit = useCallback(async () => {
    if (submitting) return;

    const validationMessage = validate();

    if (validationMessage) {
      setError(validationMessage);
      setUpgradeWarning("");
      return;
    }

    setError("");
    setUpgradeWarning("");

    try {
      await createRecurringEditMutation.mutateAsync({
        payload: buildSubmitPayload(),
        idempotencyKey: submissionKey,
      });

      showSuccess(
        t("recurringEditSuccess.created", {
          defaultValue: "Recurring edit created.",
        })
      );

      resetForm();

      if (typeof onHide === "function") {
        onHide();
      }

      navigate("/history");
    } catch (requestError) {
      const mappedError = mapCreateRecurringEditError(t, requestError);

      if (mappedError.isUpgradeRequired) {
        setUpgradeWarning(mappedError.message);
        return;
      }

      setError(mappedError.message);
      showError(mappedError.message);
    }
  }, [
    buildSubmitPayload,
    createRecurringEditMutation,
    navigate,
    onHide,
    resetForm,
    showError,
    showSuccess,
    submissionKey,
    submitting,
    t,
    validate,
  ]);

  const primaryAction = useMemo(
    () => ({
      content: t("recurringEditSaveButton", {
        defaultValue: "Save recurring edit",
      }),
      onAction: handleSubmit,
      loading: submitting,
      disabled: submitting,
    }),
    [handleSubmit, submitting, t]
  );

  const secondaryActions = useMemo(
    () => [
      {
        content: t("commonCancelButton", {
          defaultValue: "Cancel",
        }),
        onAction: handleClose,
        disabled: submitting,
      },
    ],
    [handleClose, submitting, t]
  );

  return (
    <Modal
      open={Boolean(show)}
      onClose={handleClose}
      title={t("recurringEditModalTitle", {
        defaultValue: "Create recurring edit",
      })}
      primaryAction={primaryAction}
      secondaryActions={secondaryActions}
    >
      <Modal.Section>
        <BlockStack gap="400">
          {upgradeWarning ? (
            <Banner
              tone="warning"
              title={t("recurringEditUpgradeRequired", {
                defaultValue: "Upgrade required",
              })}
              onDismiss={() => setUpgradeWarning("")}
              action={{
                content: t("recurringEditUpgradePlan", {
                  defaultValue: "View plans",
                }),
                onAction: () => navigate("/pricing"),
              }}
            >
              <p>{upgradeWarning}</p>
            </Banner>
          ) : null}

          {error ? (
            <Banner tone="critical" onDismiss={() => setError("")}>
              <p>{error}</p>
            </Banner>
          ) : null}

          <Banner tone="info">
            <p>
              {t("recurringEditDescriptionPrefix", {
                defaultValue: "This recurring edit will apply to",
              })}{" "}
              <strong>{safeProductCount}</strong>{" "}
              {t("recurringEditDescriptionSuffix", {
                defaultValue: "matching products.",
              })}
            </p>
          </Banner>

          <FormLayout>
            <TextField
              label={t("recurringEditTitleLabel", {
                defaultValue: "Title",
              })}
              value={title}
              onChange={setTitle}
              autoComplete="off"
              placeholder={t("recurringEditTitlePlaceholder", {
                defaultValue: "Recurring edit title",
              })}
              disabled={submitting}
            />

            <FormLayout.Group>
              <Select
                label={t("recurringEditFrequencyLabel", {
                  defaultValue: "Frequency",
                })}
                options={translatedFrequencyOptions}
                value={frequency}
                onChange={setFrequency}
                disabled={submitting}
              />
            </FormLayout.Group>

            <Banner tone="info">
              <p>
                {t("recurringEditTimezoneNotice", {
                  defaultValue:
                    "All recurring schedule times are interpreted in shop timezone:",
                })}{" "}
                <strong>{resolvedTimezone}</strong>.
              </p>
            </Banner>

            {requiresTime ? (
              <TextField
                label={t("recurringEditTimeLabel", {
                  defaultValue: "Time to run",
                })}
                type="time"
                value={timeToRun}
                onChange={setTimeToRun}
                helpText={t("recurringEditTimeHelpText", {
                  defaultValue:
                    "Choose the time this recurring edit should run.",
                })}
                disabled={submitting}
              />
            ) : null}

            {needsWeekdaySelection ? (
              <BlockStack gap="200">
                <Text as="p" variant="bodyMd" fontWeight="semibold">
                  {t("recurringEditDaysOfWeekLabel", {
                    defaultValue: "Days of week",
                  })}
                </Text>

                <InlineStack gap="300" wrap>
                  {DAYS_OF_WEEK.map((day) => (
                    <Checkbox
                      key={day}
                      label={t(`weekdays.${day}`, {
                        defaultValue: day,
                      })}
                      checked={daysOfWeekToRun.includes(day)}
                      onChange={(checked) =>
                        handleWeekdayChange(day, checked)
                      }
                      disabled={submitting}
                    />
                  ))}
                </InlineStack>
              </BlockStack>
            ) : null}

            {needsDayOfMonthSelection ? (
              <Select
                label={t("recurringEditDayOfMonthLabel", {
                  defaultValue: "Day of month",
                })}
                options={dayOfMonthOptions}
                value={dayOfMonthToRun}
                onChange={setDayOfMonthToRun}
                helpText={t("recurringEditDayOfMonthHelpText", {
                  defaultValue:
                    "If the selected day does not exist in a month, the backend should skip or run on the last valid day according to your scheduling policy.",
                })}
                disabled={submitting}
              />
            ) : null}

            <Checkbox
              label={t("recurringEditStartSpecificDateLabel", {
                defaultValue: "Start on a specific date",
              })}
              checked={hasStartAt}
              onChange={setHasStartAt}
              disabled={submitting}
            />

            {hasStartAt ? (
              <FormLayout.Group>
                <TextField
                  label={t("recurringEditStartDateLabel", {
                    defaultValue: "Start date",
                  })}
                  type="date"
                  value={startDate}
                  onChange={setStartDate}
                  min={startDateMin}
                  disabled={submitting}
                />

                <TextField
                  label={t("recurringEditStartTimeLabel", {
                    defaultValue: "Start time",
                  })}
                  type="time"
                  value={startTime}
                  onChange={setStartTime}
                  disabled={submitting}
                />
              </FormLayout.Group>
            ) : null}

            <Checkbox
              label={t("recurringEditStopAfterDateLabel", {
                defaultValue: "Stop after a specific date",
              })}
              checked={hasEndAt}
              onChange={setHasEndAt}
              disabled={submitting}
            />

            {hasEndAt ? (
              <FormLayout.Group>
                <TextField
                  label={t("recurringEditEndDateLabel", {
                    defaultValue: "End date",
                  })}
                  type="date"
                  value={endDate}
                  onChange={setEndDate}
                  min={endDateMin}
                  disabled={submitting}
                />

                <TextField
                  label={t("recurringEditEndTimeLabel", {
                    defaultValue: "End time",
                  })}
                  type="time"
                  value={endTime}
                  onChange={setEndTime}
                  disabled={submitting}
                />
              </FormLayout.Group>
            ) : null}
          </FormLayout>
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

export default memo(RecurringEditModal);
