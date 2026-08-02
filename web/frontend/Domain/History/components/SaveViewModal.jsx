import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

const MODAL_ID = "save-history-view-modal";

const SaveViewModal = memo(
  function SaveViewModal({
    isOpen,
    onClose,
    onSave,
    currentFilters = {},
  }) {
    const { t } = useTranslation(["history", "common"]);

    const modalRef = useRef(null);

    const [viewName, setViewName] = useState("");
    const [isDefault, setIsDefault] =
      useState(false);
    const [submitted, setSubmitted] =
      useState(false);
    const [isSaving, setIsSaving] =
      useState(false);
    const [saveError, setSaveError] =
      useState("");

    const normalizedViewName = viewName.trim();
    const viewNameError =
      submitted && !normalizedViewName
        ? t("viewNameRequired", {
          defaultValue:
            "View name is required",
        })
        : "";

    const resetForm = useCallback(() => {
      setViewName("");
      setIsDefault(false);
      setSubmitted(false);
      setIsSaving(false);
      setSaveError("");
    }, []);

    useEffect(() => {
      const modal = modalRef.current;

      if (!modal) {
        return;
      }

      if (isOpen) {
        modal.showOverlay?.();
      } else {
        modal.hideOverlay?.();
      }
    }, [isOpen]);

    const handleHidden = useCallback(() => {
      resetForm();

      if (isOpen) {
        onClose();
      }
    }, [isOpen, onClose, resetForm]);

    const handleClose = useCallback(() => {
      if (isSaving) {
        return;
      }

      modalRef.current?.hideOverlay?.();
    }, [isSaving]);

    const handleSave = useCallback(async () => {
      setSubmitted(true);
      setSaveError("");

      if (!normalizedViewName || isSaving) {
        return;
      }

      setIsSaving(true);

      try {
        await onSave({
          name: normalizedViewName,
          isDefault,
          filters: { ...currentFilters },
        });

        modalRef.current?.hideOverlay?.();
      } catch (error) {
        setSaveError(
          error instanceof Error &&
            error.message.trim()
            ? error.message
            : t("saveViewFailed", {
              defaultValue:
                "The view could not be saved.",
            }),
        );
      } finally {
        setIsSaving(false);
      }
    }, [
      currentFilters,
      isDefault,
      isSaving,
      normalizedViewName,
      onSave,
      t,
    ]);

    return (
      <s-modal
        ref={modalRef}
        id={MODAL_ID}
        heading={t("saveCustomView", {
          defaultValue: "Save Custom View",
        })}
        accessibilityLabel={t(
          "saveCustomView",
          {
            defaultValue:
              "Save Custom View",
          },
        )}
        onHide={handleHidden}
      >
        <s-stack gap="base">
          {saveError ? (
            <s-banner
              heading={t("saveViewFailedTitle", {
                defaultValue:
                  "View could not be saved",
              })}
              tone="critical"
            >
              <s-paragraph>
                {saveError}
              </s-paragraph>
            </s-banner>
          ) : null}

          <s-text-field
            label={t("viewName", {
              defaultValue: "View Name",
            })}
            name="view-name"
            value={viewName}
            autocomplete="off"
            required
            disabled={isSaving}
            error={viewNameError}
            onInput={(event) => {
              setViewName(
                event.currentTarget.value,
              );

              if (saveError) {
                setSaveError("");
              }
            }}
          ></s-text-field>

          <s-checkbox
            label={t("setAsDefault", {
              defaultValue:
                "Set as default view",
            })}
            checked={isDefault}
            disabled={isSaving}
            onChange={(event) =>
              setIsDefault(
                event.currentTarget.checked,
              )
            }
          ></s-checkbox>
        </s-stack>

        <s-button
          slot="primary-action"
          variant="primary"
          loading={isSaving}
          disabled={
            isSaving || !normalizedViewName
          }
          onClick={() => void handleSave()}
        >
          {t("saveView", {
            defaultValue: "Save View",
          })}
        </s-button>

        <s-button
          slot="secondary-actions"
          variant="secondary"
          disabled={isSaving}
          onClick={handleClose}
        >
          {t("common:cancel", {
            defaultValue: "Cancel",
          })}
        </s-button>
      </s-modal>
    );
  },
);

SaveViewModal.displayName = "SaveViewModal";

export default SaveViewModal;