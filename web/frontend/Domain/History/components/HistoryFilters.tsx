import { memo } from "react";
import { useTranslation } from "react-i18next";

type HistoryTab = {
  id: string;
  content: string;
};

interface HistoryFiltersProps {
  searchValue: string;
  onSearchChange: (value: string) => void;

  onExport: () => void;
  canExport: boolean;
  isExporting?: boolean;

  onSaveView: () => void;
  canSaveView: boolean;
  isSavingView?: boolean;

  selectedTabId: string;
  onTabChange: (id: string) => void;
  tabs: HistoryTab[];
}

const HistoryFilters = memo<HistoryFiltersProps>(
  function HistoryFilters({
    searchValue,
    onSearchChange,
    onExport,
    canExport,
    isExporting = false,
    onSaveView,
    canSaveView,
    isSavingView = false,
    selectedTabId,
    onTabChange,
    tabs,
  }) {
    const { t } = useTranslation([
      "history",
      "common",
    ]);

    return (
      <s-section
        heading={t("historyFiltersTitle")}
      >
        <s-stack gap="base">
          <s-paragraph color="subdued">
            {t("historyFiltersText")}
          </s-paragraph>

          <s-button-group gap="none">
            {tabs.map((tab) => {
              const selected =
                tab.id === selectedTabId;

              return (
                <s-button
                  key={tab.id}
                  variant="secondary"
                  aria-pressed={selected}
                  onClick={() => {
                    onTabChange(tab.id);
                  }}
                >
                  {tab.content}
                </s-button>
              );
            })}
          </s-button-group>

          <s-grid
            gridTemplateColumns="repeat(auto-fit, minmax(min(100%, 280px), 1fr))"
            gap="base"
            alignItems="end"
          >
            <s-search-field
              label={t("search", {
                defaultValue: "Search",
              })}
              labelAccessibilityVisibility="exclusive"
              name="history-search"
              placeholder={t("searchHistory")}
              value={searchValue}
              autocomplete="off"
              onInput={(event) => {
                onSearchChange(
                  event.currentTarget.value,
                );
              }}
            />

            <s-button-group gap="base">
              <s-button
                loading={isSavingView}
                disabled={
                  !canSaveView ||
                  isSavingView
                }
                onClick={onSaveView}
              >
                {t("historySaveViewButton")}
              </s-button>

              <s-button
                variant="primary"
                loading={isExporting}
                disabled={
                  !canExport ||
                  isExporting
                }
                onClick={onExport}
              >
                {t("historyExportButton")}
              </s-button>
            </s-button-group>
          </s-grid>
        </s-stack>
      </s-section>
    );
  },
);

HistoryFilters.displayName = "HistoryFilters";

export default HistoryFilters;