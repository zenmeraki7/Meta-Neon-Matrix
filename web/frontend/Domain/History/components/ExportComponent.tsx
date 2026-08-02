import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import ExportTable, {
  EXPORT_TYPE,
  EXPORT_DOWNLOAD_ERROR,
  ExportType,
  ExportDownloadErrorCode,
} from "./ExportTable";
import { useToast as useAppToast } from "../../../components/providers/ToastProvider";

type ExportTab = {
  id: string;
  label: string;
  exportType: ExportType;
};

function ExportComponent() {
  const { t } = useTranslation(["history", "common"]);
  const { showSuccess, showError } = useAppToast();

  const [selectedExportType, setSelectedExportType] =
    useState<ExportType>(EXPORT_TYPE.MANUAL);

  const tabs: ExportTab[] = [
    {
      id: "manual-exports",
      label: t("ManualExport", {
        defaultValue: "Manual Export",
      }),
      exportType: EXPORT_TYPE.MANUAL,
    },
    {
      id: "scheduled-exports",
      label: t("ScheduledExport", {
        defaultValue: "Scheduled Export",
      }),
      exportType: EXPORT_TYPE.SCHEDULED,
    },
  ];

  const handleDownloadSuccess = useCallback(() => {
    showSuccess(
      t("common:downloadSuccess", {
        defaultValue: "Download started",
      }),
    );
  }, [showSuccess, t]);

  const handleDownloadError = useCallback(
    (errorCode: ExportDownloadErrorCode) => {
      const message =
        errorCode === EXPORT_DOWNLOAD_ERROR.MISSING_ID
          ? t("common:exportDownloadLinkMissing", {
            defaultValue: "Download link is missing.",
          })
          : t("common:exportDownloadFailed", {
            defaultValue: "Download failed. Please try again.",
          });

      showError(message);
    },
    [showError, t],
  );

  return (
    <s-stack gap="large">
      <s-section
        heading={t("exportHistory", {
          defaultValue: "Export History",
        })}
      >
        <s-stack gap="base">
          <s-paragraph color="subdued">
            {t("exportOverviewText", {
              defaultValue:
                "Track generated files, monitor progress, and download completed exports.",
            })}
          </s-paragraph>

          <s-button-group gap="none">
            {tabs.map((tab) => {
              const selected =
                selectedExportType === tab.exportType;

              return (
                <s-button
                  key={tab.id}
                  variant="secondary"
                  aria-pressed={selected}
                  onClick={() => {
                    setSelectedExportType(
                      tab.exportType,
                    );
                  }}
                >
                  {tab.label}
                </s-button>
              );
            })}
          </s-button-group>
        </s-stack>
      </s-section>

      <ExportTable
        selectedType={selectedExportType}
        onDownloadSuccess={handleDownloadSuccess}
        onDownloadError={handleDownloadError}
      />
    </s-stack>
  );
}

export default ExportComponent;