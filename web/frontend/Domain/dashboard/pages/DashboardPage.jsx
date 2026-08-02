import React, {
  lazy,
  memo,
  Suspense,
  useEffect,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useDispatch } from "react-redux";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useStoreAccess } from "../hooks/useStoreAccess";
import { useApiClient } from "../../../hooks/useApiClient";
import { hydrateSubscriptionSnapshot } from "../../../store/slices/subscriptionSlice";

const PromotionalContent = lazy(() =>
  import("../components/PromotionalContent"),
);

const LANGUAGE_OPTIONS = [
  { label: "English", value: "en" },
  { label: "Deutsch", value: "de" },
  { label: "Français", value: "fr" },
  { label: "Español", value: "es" },
  { label: "Português", value: "pt" },
  { label: "Arabic", value: "ar" },
  { label: "Hindi", value: "hi" },
  { label: "Chinese", value: "zh" },
  { label: "Japanese", value: "ja" },
  { label: "Korean", value: "ko" },
  { label: "Russian", value: "ru" },
];

const METRIC_GRID_COLUMNS =
  "repeat(auto-fit, minmax(min(100%, 220px), 1fr))";

const ACTION_GRID_COLUMNS =
  "repeat(auto-fit, minmax(min(100%, 240px), 1fr))";

const OVERVIEW_GRID_COLUMNS =
  "repeat(auto-fit, minmax(min(100%, 280px), 1fr))";

const MetricCard = memo(function MetricCard({
  title,
  value,
  tone = "info",
}) {
  const numericValue = Number(value);
  const valueTone =
    Number.isFinite(numericValue) && numericValue > 0 ? "success" : "neutral";

  return (
    <s-box
      border="base"
      borderRadius="base"
      background="base"
      padding="base"
      minBlockSize="140px"
    >
      <s-stack gap="base">
        <s-grid
          gridTemplateColumns="1fr auto"
          gap="base"
          alignItems="start"
        >
          <s-stack gap="small-200">
            <s-text type="strong">{title}</s-text>

            <s-heading>
              <s-text type="strong" tone={valueTone}>
                {value}
              </s-text>
            </s-heading>
          </s-stack>

          <s-badge tone={tone}>{title}</s-badge>
        </s-grid>

        <s-paragraph color="subdued">{title}</s-paragraph>
      </s-stack>
    </s-box>
  );
});

function MetricSkeleton({ label }) {
  return (
    <s-box
      border="base"
      borderRadius="base"
      background="base"
      padding="base"
      minBlockSize="140px"
    >
      <s-stack gap="base" alignItems="center">
        <s-spinner
          size="base"
          accessibilityLabel={`Loading ${label}`}
        ></s-spinner>

        <s-text color="subdued">{label}</s-text>
      </s-stack>
    </s-box>
  );
}

function QuickActionCard({
  title,
  description,
  buttonText,
  onAction,
}) {
  return (
    <s-box
      border="base"
      borderRadius="base"
      background="base"
      padding="base"
      minBlockSize="210px"
    >
      <s-stack gap="base">
        <s-box minBlockSize="110px">
          <s-stack gap="small-200">
            <s-heading>{title}</s-heading>
            <s-paragraph color="subdued">{description}</s-paragraph>
          </s-stack>
        </s-box>

        <s-button variant="primary" onClick={onAction}>
          {buttonText}
        </s-button>
      </s-stack>
    </s-box>
  );
}

function PromotionalContentFallback({ label }) {
  return (
    <s-box
      minBlockSize="320px"
      border="base"
      borderRadius="base"
      background="subdued"
      padding="base"
    >
      <s-stack gap="base" alignItems="center">
        <s-spinner size="large" accessibilityLabel={label}></s-spinner>
        <s-text color="subdued">{label}</s-text>
      </s-stack>
    </s-box>
  );
}

export default function DashboardPage() {
  const { i18n, t } = useTranslation();
  const dispatch = useDispatch();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [showPromotionalContent, setShowPromotionalContent] =
    useState(false);

  const bootstrapQuery = useQuery({
    queryKey: ["bootstrap-dashboard"],
    queryFn: ({ signal }) =>
      api.get("/api/bootstrap/dashboard", { signal }),
    staleTime: 10_000,
    retry: 1,
  });

  const bootstrapData = bootstrapQuery.data || null;
  const bootstrapStoreDetails =
    bootstrapData?.storeDetails || null;
  const bootstrapSyncStatus =
    bootstrapData?.syncStatus || null;
  const bootstrapPlanSnapshot =
    bootstrapData?.planSnapshot || null;

  const { storeAccess, loadingStoreData } = useStoreAccess({
    initialData: bootstrapStoreDetails || undefined,
    enabled: bootstrapQuery.isError,
  });

  useEffect(() => {
    if (bootstrapStoreDetails) {
      queryClient.setQueryData(
        ["store-details"],
        bootstrapStoreDetails,
      );
    }

    if (bootstrapSyncStatus) {
      queryClient.setQueryData(
        ["sync-status"],
        bootstrapSyncStatus,
      );
    }

    if (bootstrapPlanSnapshot) {
      dispatch(
        hydrateSubscriptionSnapshot(bootstrapPlanSnapshot),
      );
    }
  }, [
    bootstrapStoreDetails,
    bootstrapSyncStatus,
    bootstrapPlanSnapshot,
    queryClient,
    dispatch,
  ]);

  const handleLanguageChange = (event) => {
    const value = event.currentTarget.value;

    void i18n.changeLanguage(value);

    const persistLanguage = () => {
      try {
        localStorage.setItem("appLanguage", value);
      } catch {
        // Language persistence is optional.
      }
    };

    if (
      typeof window !== "undefined" &&
      typeof window.requestIdleCallback === "function"
    ) {
      window.requestIdleCallback(persistLanguage);
      return;
    }

    window.setTimeout(persistLanguage, 0);
  };

  const totalBulkEditCount =
    storeAccess?.totalbulkEditCount ?? 0;
  const totalExportCount =
    storeAccess?.totalExportCount ?? 0;
  const totalImportCount =
    storeAccess?.totalImportCount ?? 0;

  const metricCards = [
    {
      key: "bulk-edits",
      title: t("bulkEdits"),
      value: totalBulkEditCount,
      tone: "success",
    },
    {
      key: "exports",
      title: t("productExports"),
      value: totalExportCount,
      tone: "info",
    },
    {
      key: "imports",
      title: t("productImports"),
      value: totalImportCount,
      tone: "warning",
    },
  ];

  const shouldShowDashboardStatusRail =
    Boolean(storeAccess?.isCreditAvailable) ||
    Boolean(storeAccess?.isProductInitiallySyncing);

  return (
    <s-page
      heading={t("dashboard")}
      subheading={t("manageStoreOperations")}
      inlineSize="large"
    >
      <s-stack gap="large">
        <s-section>
          <s-grid
            gridTemplateColumns={OVERVIEW_GRID_COLUMNS}
            gap="large"
            alignItems="start"
          >
            <s-stack gap="base">
              <s-heading>{t("Overview")}</s-heading>

              <s-paragraph color="subdued">
                {t("dashboardOverviewDescription")}
              </s-paragraph>

              <s-stack
                direction="inline"
                gap="base"
                alignItems="center"
              >
                <s-button onClick={() => navigate("/history")}>
                  {t("History")}
                </s-button>

                <s-button onClick={() => navigate("/refresh")}>
                  {t("SyncData")}
                </s-button>

                <s-button
                  variant="primary"
                  icon="plus"
                  onClick={() => navigate("/products")}
                >
                  {t("editNow")}
                </s-button>
              </s-stack>
            </s-stack>

            <s-box
              border="base"
              borderRadius="base"
              background="subdued"
              padding="base"
            >
              <s-stack gap="small-200">
                <s-heading>{t("language")}</s-heading>

                <s-paragraph color="subdued">
                  {t("chooseDashboardLanguage")}
                </s-paragraph>

                <s-select
                  label={t("language")}
                  labelAccessibilityVisibility="exclusive"
                  name="dashboard-language"
                  value={i18n.language}
                  onChange={handleLanguageChange}
                >
                  {LANGUAGE_OPTIONS.map((option) => (
                    <s-option
                      key={option.value}
                      value={option.value}
                    >
                      {option.label}
                    </s-option>
                  ))}
                </s-select>
              </s-stack>
            </s-box>
          </s-grid>
        </s-section>

        {shouldShowDashboardStatusRail ? (
          <s-stack gap="base">
            {storeAccess?.isCreditAvailable ? (
              <s-banner
                tone="success"
                heading={t(
                  "dashboardStatus.freeAccessTitle",
                )}
              >
                <s-paragraph>
                  {t("freeAccessMessage")}
                </s-paragraph>

                <s-button
                  slot="secondary-actions"
                  variant="secondary"
                  onClick={() =>
                    navigate("/suggestionpage")
                  }
                >
                  {t(
                    "dashboardStatus.requestExtension",
                  )}
                </s-button>
              </s-banner>
            ) : null}

            {storeAccess?.isProductInitiallySyncing ? (
              <s-banner
                tone="info"
                heading={t(
                  "dashboardStatus.productSyncTitle",
                )}
              >
                <s-paragraph>
                  {t("productSyncMessage")}
                </s-paragraph>

                <s-button
                  slot="secondary-actions"
                  variant="secondary"
                  onClick={() => navigate("/refresh")}
                >
                  {t("dashboardStatus.checkStatus")}
                </s-button>
              </s-banner>
            ) : null}
          </s-stack>
        ) : null}

        <s-grid
          gridTemplateColumns={METRIC_GRID_COLUMNS}
          gap="base"
        >
          {loadingStoreData
            ? metricCards.map((card) => (
              <MetricSkeleton
                key={card.key}
                label={card.title}
              />
            ))
            : metricCards.map((card) => (
              <MetricCard key={card.key} {...card} />
            ))}
        </s-grid>

        <s-section heading={t("quickActions")}>
          <s-stack gap="base">
            <s-paragraph color="subdued">
              {t("quickActionsDescription")}
            </s-paragraph>

            <s-grid
              gridTemplateColumns={ACTION_GRID_COLUMNS}
              gap="base"
              alignItems="stretch"
            >
              <QuickActionCard
                title={t("products")}
                description={t("productsDescription")}
                buttonText={t("openProducts")}
                onAction={() => navigate("/products")}
              />

              <QuickActionCard
                title={t("bulkEdit")}
                description={t("bulkEditDescription")}
                buttonText={t("createBulkEdit")}
                onAction={() => navigate("/edit")}
              />

              <QuickActionCard
                title={t("exports")}
                description={t("exportsDescription")}
                buttonText={t("createExport")}
                onAction={() => navigate("/exportdata")}
              />

              <QuickActionCard
                title={t("snippetStudio")}
                description={t(
                  "snippetStudioDescription",
                )}
                buttonText={t("openSnippetStudio")}
                onAction={() =>
                  navigate("/product-code-snippets")
                }
              />
            </s-grid>
          </s-stack>
        </s-section>

        <s-section heading={t("learnAndOptimize")}>
          <s-stack gap="base">
            <s-paragraph color="subdued">
              {t("learnAndOptimizeDescription")}
            </s-paragraph>

            {!showPromotionalContent ? (
              <s-box
                background="subdued"
                border="base"
                borderRadius="base"
                padding="base"
              >
                <s-grid
                  gridTemplateColumns="1fr auto"
                  gap="base"
                  alignItems="center"
                >
                  <s-paragraph color="subdued">
                    {t("learnAndOptimizeDescription")}
                  </s-paragraph>

                  <s-button
                    onClick={() =>
                      setShowPromotionalContent(true)
                    }
                  >
                    {t("watchDemo")}
                  </s-button>
                </s-grid>
              </s-box>
            ) : (
              <Suspense
                fallback={
                  <PromotionalContentFallback
                    label={t("loading")}
                  />
                }
              >
                <PromotionalContent />
              </Suspense>
            )}
          </s-stack>
        </s-section>
      </s-stack>
    </s-page>
  );
}