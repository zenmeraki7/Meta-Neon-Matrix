import React, { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Modal,
  FormLayout,
  Checkbox,
  TextField,
  Banner,
  InlineStack,
  Text,
  Box,
} from "@shopify/polaris";
import { useTranslation } from "react-i18next";
import { useApiClient } from "../../../../hooks/useApiClient";
import { toSafeErrorMessage } from "../../../../utils/frontendError";
import { useShopTimezone } from "../../../../hooks/useShopTimezone";
import {
  getDateInputInTimezone,
  getScheduleDateTimeValidation,
} from "../../../../utils/timezoneDateTime";
import { useToast as useAppToast } from "../../../../components/providers/ToastProvider";

const SCHEDULED_EDITS_UPGRADE_MESSAGE =
  "Scheduled edits require an active paid plan.";
const DEFAULT_BILLING_URL = "/pricing";

function ScheduleEdit({
  onHide,
  count,
  editedField,
  show,
  previewFingerprint,
  previewSignature,
  hasFreshPreview,
  hasPreviewRegistryMismatch,
}) {
  const navigate = useNavigate();
  const { t } = useTranslation(["products", "common"]);
  const api = useApiClient();
  const { shopTimezone } = useShopTimezone();
  const resolvedTimezone = shopTimezone || "UTC";
  const { showSuccess, showError } = useAppToast();
  const scheduleCapabilityQuery = useQuery({
    queryKey: ["subscription-capabilities", "scheduled-edits"],
    queryFn: async () => api.get("/api/subscription/get-plans"),
    enabled: show === true,
    staleTime: 30_000,
  });
  // State for form fields
  const [startEditChecked, setStartEditChecked] = useState(false);
  const [undoStartEditChecked, setUndoStartEditChecked] = useState(false);
  const [startEditDate, setStartEditDate] = useState("");
  const [startEditTime, setStartEditTime] = useState("");
  const [undoStartEditDate, setUndoStartEditDate] = useState("");
  const [undoStartEditTime, setUndoStartEditTime] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [upgradeWarning, setUpgradeWarning] = useState(null);
  const [upgradeBillingUrl, setUpgradeBillingUrl] = useState(null);


  // State for UI
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const previewContractId = previewFingerprint?.previewId || null;
  const approvedTargetCount = Number(previewFingerprint?.targetCount ?? count ?? 0);
  const requiresTypedConfirm =
    Number(approvedTargetCount || 0) >= 50 || !undoStartEditChecked;
  const confirmationValid =
    !requiresTypedConfirm || confirmText.trim().toUpperCase() === "SCHEDULE";
  const isUndoValid =
    !undoStartEditChecked || (undoStartEditDate && undoStartEditTime);
  const isPreviewValid =
    Boolean(previewContractId) &&
    hasFreshPreview === true &&
    hasPreviewRegistryMismatch !== true;
  const scheduleCapability = scheduleCapabilityQuery.data?.capabilities || null;
  const scheduleCapabilityLoading =
    scheduleCapabilityQuery.isLoading || scheduleCapabilityQuery.isFetching;
  const canScheduleEdits = scheduleCapability?.canScheduleEdits === true;
  const scheduleUpgradeRequired =
    scheduleCapabilityLoading === false && canScheduleEdits !== true;
  const scheduleUpgradeMessage = upgradeWarning || (
    scheduleUpgradeRequired
      ? t("scheduledEditsUpgradeRequired", {
        defaultValue: SCHEDULED_EDITS_UPGRADE_MESSAGE,
      })
      : null
  );
  const resolvedBillingUrl =
    upgradeBillingUrl ||
    scheduleCapability?.billingUrl ||
    scheduleCapability?.upgradeUrl ||
    DEFAULT_BILLING_URL;

  // Check if the form is valid
  const isFormValid =
    startEditChecked &&
    startEditDate &&
    startEditTime &&
    isUndoValid &&
    isPreviewValid &&
    canScheduleEdits &&
    confirmationValid;

  const getScheduleValidationMessage = useCallback((validation) => {
    switch (validation?.code) {
      case "MISSING_DATE":
        return t("scheduleDateRequired", {
          defaultValue: "Choose a schedule date.",
        });
      case "MISSING_TIME":
        return t("scheduleTimeRequired", {
          defaultValue: "Choose a schedule time.",
        });
      case "MISSING_TIMEZONE":
      case "INVALID_TIMEZONE":
        return t("scheduleTimezoneUnavailable", {
          defaultValue: "Shop timezone is unavailable. Refresh and try again.",
        });
      case "PAST_DATETIME":
        return t("scheduledTimeMustBeFuture", {
          defaultValue: "Scheduled edit time must be in the future.",
        });
      case "INVALID_DATETIME":
      default:
        return t("invalidScheduledDateTime", {
          defaultValue: "Enter a valid schedule date and time.",
        });
    }
  }, [t]);

  // Handle date input changes
  const handleDateChange = useCallback((value, type) => {
    if (type === "start") {
      setStartEditDate(value);
    } else {
      setUndoStartEditDate(value);
    }
  }, []);

  // Handle time input changes
  const handleTimeChange = useCallback((value, type) => {
    if (type === "start") {
      setStartEditTime(value);
    } else {
      setUndoStartEditTime(value);
    }
  }, []);

  // Handle checkbox changes
  const handleCheckboxChange = useCallback((value, type) => {
    if (type === "start") {
      setStartEditChecked(value);
      if (!value) {
        setStartEditDate("");
        setStartEditTime("");
      }
    } else {
      setUndoStartEditChecked(value);
      if (!value) {
        setUndoStartEditDate("");
        setUndoStartEditTime("");
      }
    }
  }, []);

  // Reset the form to its initial state
  const resetForm = useCallback(() => {
    setStartEditChecked(false);
    setUndoStartEditChecked(false);
    setStartEditDate("");
    setStartEditTime("");
    setUndoStartEditDate("");
    setUndoStartEditTime("");
    setConfirmText("");
    setError(null);
    setUpgradeWarning(null);
    setUpgradeBillingUrl(null);
  }, []);

  // Handle schedule edit submission
  const handleScheduleEdit = useCallback(async () => {
    if (!canScheduleEdits) {
      setUpgradeWarning(
        t("scheduledEditsUpgradeRequired", {
          defaultValue: SCHEDULED_EDITS_UPGRADE_MESSAGE,
        }),
      );
      return;
    }

    if (!isFormValid) return;

    setSubmitting(true);
    setError(null);
    setUpgradeWarning(null);

    try {
      const scheduleValidation = getScheduleDateTimeValidation({
        date: startEditDate,
        time: startEditTime,
        timeZone: resolvedTimezone,
      });

      if (import.meta.env?.DEV) {
        console.log({
          rawDate: startEditDate,
          rawTime: startEditTime,
          shopTimezone: resolvedTimezone,
          parsedShopTime: scheduleValidation.valid
            ? `${startEditDate} ${startEditTime} ${resolvedTimezone}`
            : null,
          parsedUtc: scheduleValidation.utcIso || null,
          nowUtc: new Date().toISOString(),
        });
      }

      if (!scheduleValidation.valid) {
        const message = getScheduleValidationMessage(scheduleValidation);
        setError(message);
        return;
      }

      const scheduledAt = scheduleValidation.utcIso;

      let scheduledUndoAt = null;
      if (undoStartEditChecked) {
        const undoValidation = getScheduleDateTimeValidation({
          date: undoStartEditDate,
          time: undoStartEditTime,
          timeZone: resolvedTimezone,
        });

        if (!undoValidation.valid) {
          const message = getScheduleValidationMessage(undoValidation);
          setError(message);
          return;
        }

        scheduledUndoAt = undoValidation.utcIso;
      }

      if (
        scheduledUndoAt &&
        new Date(scheduledUndoAt).getTime() <= new Date(scheduledAt).getTime()
      ) {
        const message = t("undoTimeMustBeLater", {
          defaultValue: "Undo time must be later than the scheduled edit time",
        });
        setError(message);
        return;
      }

      const payload = {
        previewContractId,
        previewId: previewContractId,
        previewFilterHash: previewFingerprint?.filterHash || null,
        previewMirrorBatchId: previewFingerprint?.mirrorBatchId || null,
        previewFieldRegistryVersion: previewFingerprint?.fieldRegistryVersion || null,
        previewOperatorRegistryVersion:
          previewFingerprint?.operatorRegistryVersion || null,
        approvedTargetCount,
        previewSignature,
        freezeMode: "STATIC_AT_SCHEDULE_CREATE",
        scheduledAt,
        scheduledUndoAt,
        timezone: resolvedTimezone,
        scheduleConfirmationText: requiresTypedConfirm ? confirmText.trim() : null,
      };

      await api.post("/api/products/schedule-task", payload, {
        idempotent: true,
      });
      // Show success toast
      showSuccess(t("schedule_msg"));

      // Reset form, close modal, and navigate to history
      setTimeout(() => {
        resetForm();
        onHide();
        navigate("/history");
      }, 1000);
    } catch (error) {
      const detail = error?.details || null;
      const errorCode = String(error?.code || detail?.code || "").toUpperCase();
      if (
        errorCode === "PRODUCT_LIMIT_EXCEEDED"
        || errorCode === "UPGRADE_REQUIRED"
        || errorCode === "FORBIDDEN"
      ) {
        if (errorCode === "UPGRADE_REQUIRED") {
          console.warn("Scheduled edit upgrade required", {
            errorId: detail?.errorId || error?.payload?.errorId || error?.errorId || null,
            feature: detail?.feature || error?.payload?.feature || null,
          });
          setUpgradeBillingUrl(
            detail?.billingUrl || error?.payload?.billingUrl || DEFAULT_BILLING_URL,
          );
          setUpgradeWarning(
            t("scheduledEditsUpgradeRequired", {
              defaultValue: SCHEDULED_EDITS_UPGRADE_MESSAGE,
            }),
          );
          return;
        }

        setUpgradeWarning(toSafeErrorMessage(t, error, "common.errors.code.PLAN_LIMIT_REACHED"));
        return;
      }
      console.error("Error scheduling edit:", error);
      const safeMessage = toSafeErrorMessage(t, error, "common.errors.generic");
      setError(safeMessage);
      showError(safeMessage);
    } finally {
      setSubmitting(false);
    }
  }, [
    isFormValid,
    canScheduleEdits,
    startEditDate,
    startEditTime,
    undoStartEditChecked,
    undoStartEditDate,
    undoStartEditTime,
    previewContractId,
    previewFingerprint,
    approvedTargetCount,
    previewSignature,
    requiresTypedConfirm,
    confirmText,
    resolvedTimezone,
    api,
    getScheduleValidationMessage,
    resetForm,
    onHide,
    navigate,
    showError,
    showSuccess,
    t,
  ]);

  return (
    <>
      <Modal
        open={show}
        onClose={() => {
          resetForm();
          onHide();
        }}
        title={t("scheduleEditLabel")}
        primaryAction={{
          content: t("schedule"),
          onAction: handleScheduleEdit,
          loading: submitting,
          disabled:
            scheduleCapabilityLoading ||
            scheduleUpgradeRequired ||
            !isFormValid ||
            submitting,
        }}
        secondaryActions={[
          {
            content: t("cancel"),
            onAction: () => {
              resetForm();
              onHide();
            },
          },
        ]}
      >
        <Modal.Section>
          <FormLayout>
    {scheduleUpgradeMessage && (
  <Banner
    tone="warning"
    title={t("upgradeRequiredTitle", { defaultValue: "Upgrade Required" })}
    onDismiss={scheduleUpgradeRequired ? undefined : () => setUpgradeWarning(null)}
    action={{
      content: t("upgradePlanButton", { defaultValue: "Upgrade plan" }),
      onAction: () => navigate(resolvedBillingUrl),
    }}
  >
    <p>{scheduleUpgradeMessage}</p>
  </Banner>
)}


            {error && (
              <Banner tone="critical" onDismiss={() => setError(null)}>
                {error}
              </Banner>
            )}

            {!isPreviewValid && (
              <Banner
                tone="critical"
                title={t("bulkEditPreviewStaleTitle", {
                  defaultValue: "Preview is stale",
                })}
              >
                <p>
                  {t("bulkEditPreviewStaleMessage", {
                    defaultValue: "Run preview again before executing this edit.",
                  })}
                </p>
              </Banner>
            )}

            <Checkbox
              label={t("startEditTime")}
              checked={startEditChecked}
              onChange={(checked) => handleCheckboxChange(checked, "start")}
            />

            <Banner tone="info">
              <p>
                {t("scheduleTimezoneNotice", {
                  defaultValue: "All schedule times are interpreted in shop timezone: {{timezone}}.",
                  timezone: resolvedTimezone,
                })}
              </p>
            </Banner>

            {startEditChecked && (
              <FormLayout.Group>
                <TextField
                  label={t("date")}
                  type="date"
                  value={startEditDate}
                  onChange={(value) => handleDateChange(value, "start")}
                  helpText={t("selectDateRunEdit")}
                  min={getDateInputInTimezone(resolvedTimezone)}
                />
                <TextField
                  label={t("time")}
                  type="time"
                  value={startEditTime}
                  onChange={(value) => handleTimeChange(value, "start")}
                  helpText={t("selectTimeRunEdit")}
                />
              </FormLayout.Group>
            )}

            <Box paddingBlockStart="400">
              <Checkbox
                label={t("scheduleUndo")}
                checked={undoStartEditChecked}
                onChange={(checked) => handleCheckboxChange(checked, "undo")}
                disabled={!startEditChecked}
                helpText={t("revertChangesNote")}
              />
            </Box>

            {undoStartEditChecked && (
              <FormLayout.Group>
                <TextField
                  label={t("undoDate")}
                  type="date"
                  value={undoStartEditDate}
                  onChange={(value) => handleDateChange(value, "undo")}
                  helpText={t("selectDateUndoEdit")}
                  min={startEditDate || getDateInputInTimezone(resolvedTimezone)}
                  error={
                    undoStartEditChecked && !undoStartEditDate
                      ? t("undoDateRequired", {
                          defaultValue: "Choose an undo date.",
                        })
                      : undefined
                  }
                />
                <TextField
                  label={t("undoTime")}
                  type="time"
                  value={undoStartEditTime}
                  onChange={(value) => handleTimeChange(value, "undo")}
                  helpText={t("selectTimeUndoEdit")}
                  error={
                    undoStartEditChecked && !undoStartEditTime
                      ? t("undoTimeRequired", {
                          defaultValue: "Choose an undo time.",
                        })
                      : undefined
                  }
                />
              </FormLayout.Group>
            )}

            {requiresTypedConfirm && (
              <TextField
                label={t("typeScheduleToConfirm", {
                  defaultValue: "Type SCHEDULE to confirm",
                })}
                value={confirmText}
                onChange={setConfirmText}
                autoComplete="off"
              />
            )}

            {startEditChecked && startEditDate && startEditTime && (
              <Box paddingBlockStart="400">
                <Banner tone="info">
                  <InlineStack gap="200" direction="vertical">
                    <Text as="p" variant="bodyMd" fontWeight="semibold">
                      {t("edit_summary")}:
                    </Text>
                    <Text as="p" variant="bodyMd">
                      {t("field")}: <strong>{t(`fieldLabels.${editedField}`, editedField)}</strong>

                    </Text>
                    <Text as="p" variant="bodyMd">
                      {t("Products")}: <strong>{count}</strong>
                    </Text>
                    <Text as="p" variant="bodyMd">
                      {t("scheduled_for")}:{" "}
                      <strong>
                        {startEditDate} {t("at")} {startEditTime}
                      </strong>
                    </Text>
                    {undoStartEditChecked &&
                      undoStartEditDate &&
                      undoStartEditTime && (
                        <Text as="p" variant="bodyMd">
                          {t("undo_scheduled_for")}:{" "}
                          <strong>
                            {undoStartEditDate} {t("at")} {undoStartEditTime}
                          </strong>
                        </Text>
                      )}
                  </InlineStack>
                </Banner>
              </Box>
            )}
          </FormLayout>
        </Modal.Section>
      </Modal>
    </>
  );
}

export default React.memo(ScheduleEdit);
