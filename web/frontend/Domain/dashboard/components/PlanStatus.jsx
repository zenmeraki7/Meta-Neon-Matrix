// web/frontend/domains/dashboard/components/PlanStatus.jsx
import React from "react";
import { Spinner, Box, InlineStack } from "@shopify/polaris";
import { useTranslation } from "react-i18next";
import { usePlanStatus } from "../hooks/usePlanStatus";
import { SBanner, SText } from "../../../components/PolarisAppHome";

/**
 * Component to display plan status and warnings using Polaris App Home Web Components
 */
const PlanStatus = () => {
  const { t } = useTranslation();
  const { loading, showAlert, dismissAlert } = usePlanStatus();

  if (loading) {
    return (
      <Box padding="800">
        <InlineStack align="center" blockAlign="center">
          <Spinner size="large" />
        </InlineStack>
      </Box>
    );
  }

  if (!showAlert) return null;

  return (
    <SBanner
      title={t("plan.warningTitle", "Plan Required")}
      tone="warning"
      onDismiss={dismissAlert}
    >
      <SText as="p">{t("plan.warningMessage", "Purchase a plan for seamless and efficient app performance.")}</SText>
    </SBanner>
  );
};

export default PlanStatus;
