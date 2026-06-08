import React, { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
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
import { getDateInputInTimezone, zonedDateTimeToUtcIso } from "../../../../utils/timezoneDateTime";
import { useToast as useAppToast } from "../../../../components/providers/ToastProvider";

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
  // State for form fields
  const [startEditChecked, setStartEditChecked] = useState(false);
  const [undoStartEditChecked, setUndoStartEditChecked] = useState(false);
  const [startEditDate, setStartEditDate] = useState("");
  const [startEditTime, setStartEditTime] = useState("");
  const [undoStartEditDate, setUndoStartEditDate] = useState("");
  const [undoStartEditTime, setUndoStartEditTime] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [upgradeWarning, setUpgradeWarning] = useState(null);


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

  // Check if the form is valid
  const isFormValid =
    startEditChecked &&
    startEditDate &&
    startEditTime &&
    isUndoValid &&
    isPreviewValid &&
    confirmationValid;

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
  }, []);

  // Handle schedule edit submission
  const handleScheduleEdit = useCallback(async () => {
    if (!isFormValid) return;

    setSubmitting(true);
    setError(null);

    try {
      const scheduledAt = zonedDateTimeToUtcIso(startEditDate, startEditTime, resolvedTimezone);
      const scheduledAtMs = new Date(scheduledAt).getTime();

      if (!Number.isFinite(scheduledAtMs) || scheduledAtMs <= Date.now()) {
        throw new Error(
          t("scheduledTimeMustBeFuture", {
            defaultValue: "Scheduled edit time must be in the future.",
          }),
        );
      }

      const scheduledUndoAt =
        undoStartEditChecked && undoStartEditDate && undoStartEditTime
          ? zonedDateTimeToUtcIso(undoStartEditDate, undoStartEditTime, resolvedTimezone)
          : null;

      if (
        scheduledUndoAt &&
        new Date(scheduledUndoAt).getTime() <= new Date(scheduledAt).getTime()
      ) {
        throw new Error(
          t("undoTimeMustBeLater", {
            defaultValue: "Undo time must be later than the scheduled edit time",
          }),
        );
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
      if (detail?.code === "PRODUCT_LIMIT_EXCEEDED" || detail?.code === "UPGRADE_REQUIRED") {
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
    api,
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
          disabled: !isFormValid || submitting,
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
    {upgradeWarning && (
  <Banner
    tone="warning"
    title={t("upgradeRequiredTitle", { defaultValue: "Upgrade Required" })}
    onDismiss={() => setUpgradeWarning(null)}
    action={{
      content: t("upgradePlanButton", { defaultValue: "Upgrade plan" }),
      onAction: () => navigate("/pricing"),
    }}
  >
    <p>{upgradeWarning}</p>
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
