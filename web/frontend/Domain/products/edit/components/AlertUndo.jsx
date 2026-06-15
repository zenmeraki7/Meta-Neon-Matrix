import React, { memo, useCallback, useMemo, useState } from "react";
import { Modal, Text, BlockStack, Box, Banner, TextField } from "@shopify/polaris";
import { useTranslation } from "react-i18next";

function safeNumber(value, fallback = null) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.floor(number);
}

function safeString(value, fallback = null, maxLength = 120) {
  if (value === undefined || value === null) return fallback;
  const stringValue = String(value).trim();
  if (!stringValue) return fallback;
  if (!Number.isFinite(maxLength) || maxLength <= 0) return stringValue;
  return stringValue.length > maxLength
    ? `${stringValue.slice(0, maxLength)}...`
    : stringValue;
}

function safeDateLabel(value, timeZone) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return date.toLocaleString(undefined, {
      timeZone,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return date.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
}

function shortOperationId(value) {
  const operationId = safeString(value, null, null);
  if (!operationId || operationId.length <= 18) return operationId;
  return `${operationId.slice(0, 9)}...${operationId.slice(-6)}`;
}

function mapUndoError(t, error) {
  const code =
    error?.response?.data?.code ||
    error?.payload?.code ||
    error?.details?.code ||
    error?.code;

  switch (code) {
    case "UNDO_ALREADY_QUEUED":
      return t("products:undoAlreadyQueued", {
        defaultValue: "Undo is already queued for this edit.",
      });
    case "UNDO_EXPIRED":
      return t("products:undoExpired", {
        defaultValue: "This edit can no longer be undone.",
      });
    case "OPERATION_NOT_UNDOABLE":
      return t("products:operationNotUndoable", {
        defaultValue: "This edit is not eligible for undo.",
      });
    case "UNDO_ELIGIBLE_TARGETS_NOT_FOUND":
      return t("products:undoNoEligibleTargets", {
        defaultValue: "No successfully edited products or variants are available to undo.",
      });
    case "UNDO_HISTORY_NOT_FOUND":
      return t("products:undoHistoryNotFound", {
        defaultValue: "The edit history record could not be found. Refresh the app and try again.",
      });
    case "UNDO_QUEUE_TRANSITION_REJECTED":
      return t("products:undoQueueRejected", {
        defaultValue: "Undo could not be queued because this edit changed state. Refresh the app and try again.",
      });
    case "UNDO_SNAPSHOT_BEFORE_VALUES_REQUIRED":
    case "UNDO_BEFORE_VALUES_REQUIRED":
      return t("products:undoBeforeValuesMissing", {
        defaultValue: "Undo cannot run because the original values are missing.",
      });
    default:
      return t("products:undoEditSubmitFailed", {
        defaultValue:
          "Unable to submit the undo request. Please retry or refresh the app.",
      });
  }
}

const UndoSummary = memo(function UndoSummary({ summary, shopTimezone }) {
  const { t } = useTranslation(["products"]);

  if (!summary) return null;

  const label = safeString(summary.label);
  const operationId = safeString(summary.operationId, null, null);
  const operationDisplayId = shortOperationId(operationId);
  const affectedProducts = safeNumber(summary.affectedProducts);
  const affectedVariants = safeNumber(summary.affectedVariants);
  const editedAt = safeDateLabel(summary.createdAt || summary.editedAt, shopTimezone);
  const editedAtWithZone = editedAt && shopTimezone ? `${editedAt} ${shopTimezone}` : editedAt;

  if (
    affectedProducts === null &&
    affectedVariants === null &&
    !label &&
    !operationDisplayId &&
    !editedAt
  ) {
    return null;
  }

  return (
    <Box paddingBlockStart="200">
      <BlockStack gap="100">
        {label ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {t("products:undoEditSummaryLabel", {
              defaultValue: "Edit: {{label}}",
              label,
            })}
          </Text>
        ) : null}

        {editedAt ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {t("products:undoEditEditedAt", {
              defaultValue: "Edited at: {{editedAt}}",
              editedAt: editedAtWithZone,
            })}
          </Text>
        ) : null}

        {affectedProducts !== null ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {t("products:undoEditAffectedProducts", {
              defaultValue: "Affected products: {{count}}",
              count: affectedProducts,
            })}
          </Text>
        ) : null}

        {affectedVariants !== null ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {t("products:undoEditAffectedVariants", {
              defaultValue: "Affected variants: {{count}}",
              count: affectedVariants,
            })}
          </Text>
        ) : null}

        {operationDisplayId ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {t("products:undoEditOperationId", {
              defaultValue: "Operation: {{operationId}}",
              operationId: operationDisplayId,
            })}
          </Text>
        ) : null}

        {operationId && operationId !== operationDisplayId ? (
          <TextField
            label={t("products:undoEditFullOperationId", {
              defaultValue: "Full operation ID",
            })}
            value={operationId}
            readOnly
            autoComplete="off"
          />
        ) : null}
      </BlockStack>
    </Box>
  );
});

function AlertUndo({
  show,
  handleClose,
  undoEditHistory,
  loading = false,
  undoSummary = null,
  idempotencyKey = null,
  shopTimezone = null,
}) {
  const { t } = useTranslation(["products", "common"]);
  const [submitStatus, setSubmitStatus] = useState("idle");
  const [submitError, setSubmitError] = useState(null);
  const [confirmationValue, setConfirmationValue] = useState("");

  const operationId = safeString(undoSummary?.operationId, null, 120);
  const historyId = safeString(undoSummary?.historyId, null, null);
  const affectedProducts = safeNumber(undoSummary?.affectedProducts, 0);
  const affectedVariants = safeNumber(undoSummary?.affectedVariants, 0);
  const affectedCount = (affectedProducts ?? 0) + (affectedVariants ?? 0);
  const hasSuspiciousZeroAffectedCount =
    affectedProducts === 0 && affectedVariants === 0;
  const requiresTypedConfirmation = affectedCount >= 1000;
  const operationLabel = safeString(undoSummary?.label, null, null);
  const normalizedConfirmationValue = safeString(confirmationValue, "", null);
  const hasTypedConfirmation =
    !requiresTypedConfirmation ||
    normalizedConfirmationValue === "UNDO" ||
    (operationLabel && normalizedConfirmationValue === operationLabel);
  const isSubmitting = submitStatus === "submitting";
  const isAccepted = submitStatus === "accepted";
  const isBusy = loading || isSubmitting;
  const canUndo =
    typeof undoEditHistory === "function" &&
    Boolean(operationId) &&
    hasTypedConfirmation &&
    !isBusy &&
    !isAccepted;

  const handleModalClose = useCallback(() => {
    if (isBusy) return;
    setSubmitError(null);
    setSubmitStatus("idle");
    setConfirmationValue("");
    if (typeof handleClose === "function") {
      handleClose();
    }
  }, [handleClose, isBusy]);

  const handleUndo = useCallback(async () => {
    if (!canUndo) return;

    try {
      setSubmitError(null);
      setSubmitStatus("submitting");
      console.info("[undo-ui] submit", {
        operationId,
        historyId,
        hasIdempotencyKey: Boolean(idempotencyKey),
      });
      await undoEditHistory({
        operationId,
        historyId,
        idempotencyKey: idempotencyKey || `undo:${operationId}`,
      });
      setSubmitStatus("accepted");
    } catch (error) {
      console.error("[undo-ui] submit_failed", {
        operationId,
        historyId,
        code: error?.code || error?.payload?.code || null,
        status: error?.status || null,
        rootCause: error?.payload?.rootCause || error?.message || null,
        errorId: error?.payload?.errorId || null,
      });
      setSubmitStatus("failed");
      setSubmitError(mapUndoError(t, error));
    }
  }, [canUndo, historyId, idempotencyKey, operationId, t, undoEditHistory]);

  const primaryAction = useMemo(
    () => ({
      content: submitStatus === "accepted"
        ? t("products:undoEditQueued", { defaultValue: "Undo queued" })
        : t("products:yesUndoEdit", { defaultValue: "Yes, undo edit" }),
      tone: "critical",
      onAction: handleUndo,
      loading: submitStatus === "submitting",
      disabled: !canUndo,
    }),
    [canUndo, handleUndo, submitStatus, t],
  );

  const secondaryActions = useMemo(
    () => [
      {
        content: t("common:cancel", { defaultValue: "Cancel" }),
        onAction: handleModalClose,
        disabled: isBusy,
      },
    ],
    [handleModalClose, isBusy, t],
  );

  if (!show) return null;

  return (
    <Modal
      open={Boolean(show)}
      onClose={handleModalClose}
      title={t("products:undoEdit", { defaultValue: "Undo edit" })}
      size="small"
      primaryAction={primaryAction}
      secondaryActions={secondaryActions}
    >
      <Modal.Section>
        <BlockStack gap="200">
          <Text as="p" variant="bodyMd">
            {t("products:confirmUndoMessage", {
              defaultValue:
                "Are you sure you want to undo this edit? This action will attempt to restore the previous product values.",
            })}
          </Text>

          <Banner tone="warning">
            <p>
              {t("products:undoEditDestructiveWarning", {
                defaultValue:
                  "This is an operationally sensitive action. Review the edit details below before continuing.",
              })}
            </p>
          </Banner>

          <UndoSummary summary={undoSummary} shopTimezone={shopTimezone} />

          {hasSuspiciousZeroAffectedCount ? (
            <Banner tone="warning">
              <p>
                {t("products:undoEditNoRecordedTargets", {
                  defaultValue:
                    "This edit has no recorded affected products or variants. Undo may not be available.",
                })}
              </p>
            </Banner>
          ) : null}

          {!operationId ? (
            <Banner tone="critical">
              <p>
                {t("products:undoMissingOperationId", {
                  defaultValue:
                    "This edit cannot be undone because its operation identity is missing.",
                })}
              </p>
            </Banner>
          ) : null}

          {requiresTypedConfirmation ? (
            <TextField
              label={t("products:undoEditConfirmationLabel", {
                defaultValue: "Type UNDO to confirm",
              })}
              value={confirmationValue}
              onChange={setConfirmationValue}
              autoComplete="off"
              disabled={isBusy || isAccepted}
              helpText={t("products:undoEditConfirmationHelpText", {
                defaultValue:
                  "Large undo requests require typed confirmation before they can be queued.",
              })}
            />
          ) : null}

          {submitError ? (
            <Banner tone="critical">
              <p>{submitError}</p>
            </Banner>
          ) : null}

          {isAccepted ? (
            <Banner tone="success">
              <p>
                {t("products:undoEditAcceptedMessage", {
                  defaultValue:
                    "Undo request accepted. You can track progress in history.",
                })}
              </p>
            </Banner>
          ) : null}

          {isBusy ? (
            <Text as="p" variant="bodySm" tone="subdued">
              {t("products:undoEditSubmittingMessage", {
                defaultValue:
                  "Undo is being submitted. Please keep this window open until the request is accepted.",
              })}
            </Text>
          ) : null}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}

export default memo(AlertUndo);
