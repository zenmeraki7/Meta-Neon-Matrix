import React, { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  Modal,
  FormLayout,
  Checkbox,
  TextField,
  Banner,
  Box,
} from "@shopify/polaris";

import { useTranslation } from "react-i18next";
import { buildFilterAstFromLegacyFilters } from "../../list/utils/filterAst.js";
import { useApiClient } from "../../../../hooks/useApiClient";
import { useShopTimezone } from "../../../../hooks/useShopTimezone";
import { getDateInputInTimezone, zonedDateTimeToUtcIso } from "../../../../utils/timezoneDateTime";
import { useToast as useAppToast } from "../../../../components/providers/ToastProvider";
import { toSafeErrorMessage } from "../../../../utils/frontendError";


function ScheduledExportModal({
  show,
  onHide,
  fileName,
  selectedFields,
  filters,
}) {
  const { t } = useTranslation();
  const api = useApiClient();
  const { shopTimezone } = useShopTimezone();
  const resolvedTimezone = shopTimezone || "UTC";
  const { showSuccess, showError } = useAppToast();

  const navigate = useNavigate();
  const [startExportChecked, setStartExportChecked] = useState(true);
  const [startExportDate, setStartExportDate] = useState("");
  const [startExportTime, setStartExportTime] = useState("");
  const [upgradeWarning, setUpgradeWarning] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const isFormValid =
    startExportChecked &&
    Boolean(startExportDate) &&
    Boolean(startExportTime) &&
    Boolean(fileName?.trim()) &&
    Array.isArray(selectedFields) &&
    selectedFields.length > 0;

  const resetForm = useCallback(() => {
    setStartExportChecked(true);
    setStartExportDate("");
    setStartExportTime("");
    setUpgradeWarning(null);
    setSubmitting(false);
    setError(null);
  }, []);

  const handleClose = useCallback(() => {
    resetForm();
    onHide();
  }, [onHide, resetForm]);

 const handleScheduleExport = useCallback(async () => {
  if (!isFormValid) return;

  setSubmitting(true);
  setError(null);
  setUpgradeWarning(null);

  try {
    const scheduledAt = zonedDateTimeToUtcIso(startExportDate, startExportTime, resolvedTimezone);

    const payload = {
      title: fileName.replace(/\.csv$/i, ""),
      filename: fileName,
      fields: selectedFields,
      filterParams: filters,
      filterAst: buildFilterAstFromLegacyFilters({
        filterParams: filters,
        targetGranularity: "PRODUCT",
        source: "SCHEDULED_EXPORT_DEFINITION",
      }),
      scheduledAt,
      timezone: resolvedTimezone,
      status: "Active",
    };

    try {
      await api.post("/api/products/create-scheduled-export", payload, {
        idempotent: true,
      });
    } catch (requestError) {
      const errorCode =
        requestError?.payload?.code ||
        requestError?.payload?.message ||
        requestError?.message ||
        "SCHEDULED_EXPORT_FAILED";

      // 🔥 Upgrade case
      if (errorCode === "SCHEDULED_EXPORT_PLAN_UPGRADE_REQUIRED") {
        setUpgradeWarning(
          t("scheduledExport.upgradeRequiredMessage")
        );
        return;
      }

      // 🔥 Generic errors
      throw new Error(
        t(
          `scheduledExport.errors.${errorCode}`,
          t("scheduledExport.failedMessage")
        )
      );
    }

    // ✅ Success
    showSuccess(t("scheduledExport.successMessage"));

    setTimeout(() => {
      handleClose();
      navigate("/history");
    }, 1000);

  } catch (requestError) {
    const message = toSafeErrorMessage(
      t,
      requestError,
      "common.errors.generic",
    );

    setError(message);

    showError(message);
  } finally {
    setSubmitting(false);
  }
}, [
  fileName,
  filters,
  handleClose,
  isFormValid,
  navigate,
  selectedFields,
  startExportDate,
  startExportTime,
  resolvedTimezone,
  api,
  t,
  showError,
  showSuccess,
]);

  return (
    <>
      <Modal
        open={show}
        onClose={handleClose}
         title={t("scheduledExport.modalTitle")}
        primaryAction={{
          content: t("scheduledExport.scheduleButton"),
          onAction: handleScheduleExport,
          loading: submitting,
          disabled: !isFormValid || submitting,
        }}
        secondaryActions={[
          {
            content: t("scheduledExport.cancelButton"),
            onAction: handleClose,
          },
        ]}
      >
        <Modal.Section>
          <FormLayout>
            {upgradeWarning && (
              <Banner
                tone="warning"
                title={t("scheduledExport.upgradeRequiredTitle")}
                onDismiss={() => setUpgradeWarning(null)}
                action={{
                   content: t("scheduledExport.upgradePlanButton"),
                  onAction: () => navigate("/pricing"),
                }}
              >
                <p>{upgradeWarning}</p>
              </Banner>
            )}

            {error && (
              <Banner tone="critical" onDismiss={() => setError(null)}>
                <p>{error}</p>
              </Banner>
            )}

            <Checkbox
              label={t("scheduledExport.startExportCheckbox")}
              checked={startExportChecked}
              onChange={(checked) => setStartExportChecked(checked)}
            />

            <Banner tone="info">
              <p>
                {t("scheduleTimezoneNotice", {
                  defaultValue: "All schedule times are interpreted in shop timezone: {{timezone}}.",
                  timezone: resolvedTimezone,
                })}
              </p>
            </Banner>

            {startExportChecked && (
              <FormLayout.Group>
                <TextField
                  label={t("scheduledExport.dateLabel")}
                  type="date"
                  value={startExportDate}
                  onChange={setStartExportDate}
                  helpText={t("scheduledExport.dateHelpText")}
                  min={getDateInputInTimezone(resolvedTimezone)}
                />
                <TextField
                   label={t("scheduledExport.timeLabel")}
                  type="time"
                  value={startExportTime}
                  onChange={setStartExportTime}
                  helpText={t("scheduledExport.timeHelpText")}
                />
              </FormLayout.Group>
            )}

            <Box paddingBlockStart="200" />
          </FormLayout>
        </Modal.Section>
      </Modal>
    </>
  );
}

export default React.memo(ScheduledExportModal);
