import React, { memo, useCallback, useMemo, useState } from "react";
import {
  Modal,
  Text,
  BlockStack,
  Box,
  Banner,
  TextField,
} from "@shopify/polaris";
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
  const status = Number(error?.status || error?.response?.status || 0);
  const errorId =
    error?.payload?.errorId ||
    error?.details?.errorId ||
    error?.errorId ||
    null;

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
        defaultValue:
          "No successfully edited products or variants are available to undo.",
      });
    case "CSV_CREATE_UNDO_NOT_SUPPORTED":
      return t("products:csvCreateUndoNotSupported", {
        defaultValue:
          "This import created a new product. It cannot be safely undone because no previous product state exists.",
      });
    case "UNDO_HISTORY_NOT_FOUND":
      return t("products:undoHistoryNotFound", {
        defaultValue:
          "The edit history record could not be found. Refresh the app and try again.",
      });
    case "UNDO_QUEUE_TRANSITION_REJECTED":
      return t("products:undoQueueRejected", {
        defaultValue:
          "Undo could not be queued because this edit changed state. Refresh the app and try again.",
      });
    case "UNDO_SNAPSHOT_BEFORE_VALUES_REQUIRED":
    case "UNDO_BEFORE_VALUES_REQUIRED":
    case "UNDO_SNAPSHOTS_INCOMPLETE":
      return t("products:undoBeforeValuesMissing", {
        defaultValue:
          "Undo cannot run because the original values are missing.",
      });
    case "INVALID_HISTORY_ID":
    case "INVALID_OPERATION_ID":
      return t("products:undoMissingOperationId", {
        defaultValue:
          "This edit cannot be undone because its full history identity is missing.",
      });
    case "APP_BRIDGE_CONTEXT_MISSING":
    case "SESSION_TOKEN_UNAVAILABLE":
    case "AUTH_FETCH_UNAVAILABLE":
      return t("products:undoAuthUnavailable", {
        defaultValue:
          "The Shopify session token is not available. Reopen or refresh the embedded app and try again.",
      });
    case "SESSION_TOKEN_ACQUISITION_FAILED":
      return t("products:undoTokenAcquisitionFailed", {
        defaultValue:
          "Shopify could not create a fresh session token. Refresh the embedded app and try again.",
      });
    case "UNAUTHENTICATED":
    case "AUTHENTICATION_REQUIRED":
    case "AUTH_REQUIRED":
    case "UNAUTHORIZED":
    case "SHOPIFY_AUTHORIZATION_MISSING":
      return t("products:undoAuthenticationRejected", {
        defaultValue:
          "Shopify rejected this session. Reopen the app from Shopify Admin and try again.",
      });
    case "SESSION_EXPIRED":
    case "REAUTH_REQUIRED":
      return t("products:undoSessionExpired", {
        defaultValue:
          "Your Shopify session expired. Reopen the embedded app and try again.",
      });
    case "NETWORK_FAILURE":
      return t("products:undoNetworkFailure", {
        defaultValue:
          "The undo request could not reach the server. Check your connection and try again.",
      });
    case "DATABASE_UNAVAILABLE":
      return t("products:undoDatabaseUnavailable", {
        defaultValue: "Undo is temporarily unavailable. Please retry.",
      });
    case "UNDO_NOT_ALLOWED":
    case "FORBIDDEN":
      return t("products:undoNotPermitted", {
        defaultValue: "This edit is not permitted to be undone.",
      });
    case "UNDO_ALREADY_REQUESTED":
      return t("products:undoAlreadyQueued", {
        defaultValue: "Undo is already queued for this edit.",
      });
    case "SNAPSHOT_NOT_AVAILABLE":
      return t("products:undoBeforeValuesMissing", {
        defaultValue:
          "Undo cannot run because the original values are missing.",
      });
    default:
      if (status === 401) {
        return t("products:undoAuthenticationRejected", {
          defaultValue:
            "Shopify rejected this session. Reopen the app from Shopify Admin and try again.",
        });
      }
      if (status === 403) {
        return t("products:undoNotPermitted", {
          defaultValue: "This edit is not permitted to be undone.",
        });
      }
      if (status === 404) {
        return t("products:undoEndpointUnavailable", {
          defaultValue:
            "The undo API route is unavailable. Restart the app backend and try again.",
        });
      }
      if (status === 409) {
        return t("products:undoRequestRejected", {
          defaultValue:
            "The undo request was rejected because this edit changed state. Refresh and try again.",
        });
      }
      if (status >= 500) {
        const reference = errorId ? ` Reference: ${errorId}` : "";
        return t("products:undoServerFailure", {
          defaultValue: `The server could not accept the undo request.${reference}`,
        });
      }
      return t("products:undoEditSubmitFailed", {
        defaultValue:
          "Unable to submit the undo request. Please retry or refresh the app.",
      });
  }
}

const UndoSummary = memo(function UndoSummary({ summary, displayTimezone }) {
  const { t } = useTranslation(["products"]);

  if (!summary) return null;

  const label = safeString(summary.label);
  const operationId = safeString(summary.operationId, null, null);
  const operationDisplayId = shortOperationId(operationId);
  const affectedProducts = safeNumber(summary.affectedProducts);
  const affectedVariants = safeNumber(summary.affectedVariants);
  const editedAt = safeDateLabel(
    summary.createdAt || summary.editedAt,
    displayTimezone
  );
  const editedAtWithZone =
    editedAt && displayTimezone ? `${editedAt} ${displayTimezone}` : editedAt;

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
  displayTimezone = null,
}) {
  const { t } = useTranslation(["products", "common"]);
  const [submitStatus, setSubmitStatus] = useState("idle");
  const [submitError, setSubmitError] = useState(null);
  const [confirmationValue, setConfirmationValue] = useState("");

  const operationId = safeString(undoSummary?.operationId, null, null);
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
    Boolean(historyId) &&
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
      await undoEditHistory({
        historyId,
        operationId,
        idempotencyKey: idempotencyKey || `undo:${historyId}`,
      });
      setSubmitStatus("accepted");
      if (typeof handleClose === "function") handleClose();
    } catch (error) {
      setSubmitStatus("failed");
      setSubmitError(mapUndoError(t, error));
    }
  }, [
    canUndo,
    handleClose,
    historyId,
    idempotencyKey,
    operationId,
    t,
    undoEditHistory,
  ]);

  const primaryAction = useMemo(
    () => ({
      content:
        submitStatus === "accepted"
          ? t("products:undoEditQueued", { defaultValue: "Undo queued" })
          : t("products:yesUndoEdit", { defaultValue: "Yes, undo edit" }),
      tone: "critical",
      onAction: handleUndo,
      loading: submitStatus === "submitting",
      disabled: !canUndo,
    }),
    [canUndo, handleUndo, submitStatus, t]
  );

  const secondaryActions = useMemo(
    () => [
      {
        content: t("common:cancel", { defaultValue: "Cancel" }),
        onAction: handleModalClose,
        disabled: isBusy,
      },
    ],
    [handleModalClose, isBusy, t]
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

          <UndoSummary
            summary={undoSummary}
            displayTimezone={displayTimezone}
          />

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

          {!historyId ? (
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
