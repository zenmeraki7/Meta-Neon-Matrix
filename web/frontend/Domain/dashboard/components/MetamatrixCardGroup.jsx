import { useTranslation } from "react-i18next";

const CARD_GRID_COLUMNS =
  "repeat(auto-fit, minmax(min(100%, 240px), 1fr))";

const FEATURE_CARDS = Object.freeze([
  Object.freeze({
    key: "bulk-editing",
    icon: "edit",
    titleKey: "tipsForBulkEditing",
    descriptionKey: "bulkEditingTipDescription",
    href: "/bulk-edit",
  }),
  Object.freeze({
    key: "spreadsheet",
    icon: "import",
    titleKey: "editWithSpreadsheet",
    descriptionKey: "editWithSpreadsheetDescription",
    href: "/spreadsheet",
  }),
  Object.freeze({
    key: "export",
    icon: "export",
    titleKey: "exportProductData",
    descriptionKey: "exportProductDataDescription",
    href: "/exports",
  }),
  Object.freeze({
    key: "changelog",
    icon: "clock",
    titleKey: "metamatrixChangelog",
    descriptionKey: "metamatrixChangelogDescription",
    href: "/changelog",
  }),
]);

function FeatureCard({
  icon,
  title,
  description,
  href,
}) {
  return (
    <s-box
      background="base"
      border="base"
      borderRadius="base"
      padding="base"
    >
      <s-stack gap="large">
        <s-box
          background="subdued"
          borderRadius="base"
          padding="small"
          inlineSize="fit-content"
        >
          <s-icon type={icon} />
        </s-box>

        <s-stack gap="small-200">
          <s-heading>{title}</s-heading>

          <s-paragraph color="subdued">
            {description}
          </s-paragraph>
        </s-stack>

        <s-link href={href}>{title}</s-link>
      </s-stack>
    </s-box>
  );
}

export function MetamatrixCardGroup() {
  const { t } = useTranslation();

  return (
    <s-section heading={t("learnMore")}>
      <s-grid
        gridTemplateColumns={CARD_GRID_COLUMNS}
        gap="base"
        alignItems="stretch"
      >
        {FEATURE_CARDS.map((card) => (
          <FeatureCard
            key={card.key}
            icon={card.icon}
            title={t(card.titleKey)}
            description={t(card.descriptionKey)}
            href={card.href}
          />
        ))}
      </s-grid>
    </s-section>
  );
}

export default MetamatrixCardGroup;