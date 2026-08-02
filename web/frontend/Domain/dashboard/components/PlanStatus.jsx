import { useTranslation } from "react-i18next";
import { usePlanStatus } from "../hooks/usePlanStatus";

function PlanStatus() {
  const { t } = useTranslation();
  const {
    loading,
    status,
  } = usePlanStatus();

  if (loading || status === "ACTIVE") {
    return null;
  }

  if (status !== "PLAN_REQUIRED") {
    return null;
  }

  return (
    <s-banner
      heading={t("planWarningTitle", {
        defaultValue: "Plan required",
      })}
      tone="warning"
    >
      <s-paragraph>
        <s-text>
          {t("planWarningMessage", {
            defaultValue:
              "Choose a plan to start creating and running bulk edits.",
          })}
        </s-text>
      </s-paragraph>

      <s-button
        slot="primary-action"
        href="/plans"
      >
        {t("choosePlan", {
          defaultValue: "Choose a plan",
        })}
      </s-button>
    </s-banner>
  );
}

export default PlanStatus;