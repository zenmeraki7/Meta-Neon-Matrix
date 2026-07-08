import React, { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
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
import { useScheduleTimezone } from "../../../../hooks/useScheduleTimezone";
import { getDateInputInTimezone, zonedDateTimeToUtcIso } from "../../../../utils/timezoneDateTime";
import { useToast as useAppToast } from "../../../../components/providers/ToastProvider";
import { toSafeErrorMessage } from "../../../../utils/frontendError";

const SCHEDULED_EXPORTS_UPGRADE_MESSAGE =
  "Scheduled exports are not available on your current plan.";
const DEFAULT_BILLING_URL = "/pricing";

function ScheduledExportModal({
  show,
  onHide,
  fileName,
  selectedFields,
  filters,
}) {
  const { t } = useTranslation();
  const api = useApiClient();
  const { scheduleTimezone } = useScheduleTimezone();
  const resolvedTimezone = scheduleTimezone || "UTC";
  const { showSuccess, showError } = useAppToast();
  const scheduleCapabilityQuery = useQuery({
    queryKey: ["subscription-capabilities", "scheduled-exports"],
    queryFn: async () => api.get("/api/subscription/get-plans"),
    enabled: show === true,
    staleTime: 30_000,
  });

  const navigate = useNavigate();
  const [startExportChecked, setStartExportChecked] = useState(true);
  const [startExportDate, setStartExportDate] = useState("");
  const [startExportTime, setStartExportTime] = useState("");
  const [upgradeWarning, setUpgradeWarning] = useState(null);
  const [upgradeBillingUrl, setUpgradeBillingUrl] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const scheduleCapability = scheduleCapabilityQuery.data?.capabilities || null;
  const scheduleCapabilityLoading =
    scheduleCapabilityQuery.isLoading || scheduleCapabilityQuery.isFetching;
  const canScheduleExports = scheduleCapability?.canScheduleExports === true;
  const scheduleUpgradeRequired =
    scheduleCapabilityLoading === false && canScheduleExports !== true;
  const scheduleUpgradeMessage = upgradeWarning || (
    scheduleUpgradeRequired
      ? t("scheduledExport.upgradeRequiredMessage", {
        defaultValue: SCHEDULED_EXPORTS_UPGRADE_MESSAGE,
      })
      : null
  );
  const resolvedBillingUrl =
    upgradeBillingUrl ||
    scheduleCapability?.billingUrl ||
    scheduleCapability?.upgradeUrl ||
    DEFAULT_BILLING_URL;

  const isFormValid =
    startExportChecked &&
    Boolean(startExportDate) &&
    Boolean(startExportTime) &&
    Boolean(fileName?.trim()) &&
    Array.isArray(selectedFields) &&
    selectedFields.length > 0 &&
    canScheduleExports;

  const resetForm = useCallback(() => {
    setStartExportChecked(true);
    setStartExportDate("");
    setStartExportTime("");
    setUpgradeWarning(null);
    setUpgradeBillingUrl(null);
    setSubmitting(false);
    setError(null);
  }, []);

  const handleClose = useCallback(() => {
    resetForm();
    onHide();
  }, [onHide, resetForm]);

 const handleScheduleExport = useCallback(async () => {
  if (!canScheduleExports) {
    setUpgradeWarning(
      t("scheduledExport.upgradeRequiredMessage", {
        defaultValue: SCHEDULED_EXPORTS_UPGRADE_MESSAGE,
      }),
    );
    return;
  }

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
      if (
        errorCode === "UPGRADE_REQUIRED" ||
        errorCode === "SCHEDULED_EXPORT_PLAN_UPGRADE_REQUIRED" ||
        requestError?.payload?.upgradeRequired === true
      ) {
        setUpgradeBillingUrl(
          requestError?.payload?.billingUrl ||
          requestError?.details?.billingUrl ||
          DEFAULT_BILLING_URL,
        );
        setUpgradeWarning(
          requestError?.payload?.message ||
          t("scheduledExport.upgradeRequiredMessage", {
            defaultValue: SCHEDULED_EXPORTS_UPGRADE_MESSAGE,
          })
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
  canScheduleExports,
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
          disabled:
            scheduleCapabilityLoading ||
            scheduleUpgradeRequired ||
            !isFormValid ||
            submitting,
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
            {scheduleUpgradeMessage && (
              <Banner
                tone="warning"
                title={t("scheduledExport.upgradeRequiredTitle")}
                onDismiss={scheduleUpgradeRequired ? undefined : () => setUpgradeWarning(null)}
                action={{
                   content: t("scheduledExport.upgradePlanButton"),
                  onAction: () => navigate(resolvedBillingUrl),
                }}
              >
                <p>{scheduleUpgradeMessage}</p>
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
                  defaultValue: "All schedule times are interpreted in your local timezone: {{timezone}}.",
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
