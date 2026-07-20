import React from "react";
import { useTranslation } from "react-i18next";
import { Banner, Box, Button } from "@shopify/polaris";

const POLARIS_PROPS = Object.freeze({
  primaryVariant: "primary",
  slimSize: "slim",
});

const PlanBanner = ({ plan }) => {
  const { t } = useTranslation();

  // If no plan data or user is on premium plan, don't show banner
  if (!plan || plan.active) return null;

  const editLimitReached = plan.currentEditCount >= plan.maxEdits;

  return (
    <Banner
      title={t(
        editLimitReached
          ? "planBanner.limitReachedTitle"
          : "planBanner.usageTitle"
      )}
      tone={editLimitReached ? "critical" : "info"}
    >
      <p>
        {editLimitReached
          ? t("planBanner.limitReachedMessage", {
            current: plan.currentEditCount,
            maximum: plan.maxEdits,
          })
          : t("planBanner.usageMessage", {
            current: plan.currentEditCount,
            maximum: plan.maxEdits,
            products: plan.maxProductsPerEdit,
          })}
      </p>
      <Box paddingBlockStart="200">
        <Button
          variant={POLARIS_PROPS.primaryVariant}
          size={POLARIS_PROPS.slimSize}
          url="/plans"
        >
          {t(editLimitReached ? "planBanner.upgradeNow" : "planBanner.upgrade")}
        </Button>
      </Box>
    </Banner>
  );
};

export default PlanBanner;
