import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

const METRIC_GRID_COLUMNS =
  "repeat(auto-fit, minmax(min(100%, 220px), 1fr))";

const METRIC_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: "bulkEdits",
    icon: "edit",
    labelKey: "bulkEdits",
    totalKey: "bulkEdits",
  }),
  Object.freeze({
    key: "productExports",
    icon: "export",
    labelKey: "productExports",
    totalKey: "exports",
  }),
  Object.freeze({
    key: "productImports",
    icon: "import",
    labelKey: "productImports",
    totalKey: "imports",
  }),
]);

function normalizeMetricCount(value) {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    typeof value === "boolean"
  ) {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return Math.trunc(parsed);
}

const MetricCard = memo(function MetricCard({
  icon,
  label,
  displayValue,
  loading,
  loadingLabel,
}) {
  return (
    <s-box
      background="base"
      border="base"
      borderRadius="base"
      padding="base"
    >
      <s-grid
        gridTemplateColumns="auto 1fr"
        gap="base"
        alignItems="center"
      >
        <s-box
          background="subdued"
          borderRadius="base"
          padding="small"
        >
          <s-icon type={icon} />
        </s-box>

        <s-stack gap="small-200">
          <s-text color="subdued">{label}</s-text>

          {loading ? (
            <s-spinner
              size="base"
              accessibilityLabel={loadingLabel}
            />
          ) : (
            <s-heading>
              <s-text type="strong">
                {displayValue}
              </s-text>
            </s-heading>
          )}
        </s-stack>
      </s-grid>
    </s-box>
  );
});

export function MetricsSection({ loading, data }) {
  const { t, i18n } = useTranslation();

  const totals = data?.totals ?? {};
  const locale =
    i18n.resolvedLanguage ||
    i18n.language ||
    "en";

  const numberFormatter = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        maximumFractionDigits: 0,
      }),
    [locale],
  );

  const unavailableLabel = loading
    ? ""
    : t("metricUnavailable", {
        defaultValue: "—",
      });

  return (
    <s-grid
      gridTemplateColumns={METRIC_GRID_COLUMNS}
      gap="base"
      alignItems="stretch"
    >
      {METRIC_DEFINITIONS.map((metric) => {
        const label = t(metric.labelKey);

        const count = loading
          ? null
          : normalizeMetricCount(
              totals[metric.totalKey],
            );

        const displayValue = loading
          ? ""
          : count === null
            ? unavailableLabel
            : numberFormatter.format(count);

        return (
          <MetricCard
            key={metric.key}
            icon={metric.icon}
            label={label}
            displayValue={displayValue}
            loading={loading}
            loadingLabel={t("loadingMetric", {
              label,
              defaultValue: `Loading ${label}`,
            })}
          />
        );
      })}
    </s-grid>
  );
}

export default memo(MetricsSection);