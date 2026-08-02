import { useTranslation } from "react-i18next";

const USAGE_WARNING_THRESHOLD = 0.8;

function parseNonNegativeInteger(value) {
  if (
    typeof value !== "number" &&
    typeof value !== "string"
  ) {
    return null;
  }

  if (
    typeof value === "string" &&
    value.trim() === ""
  ) {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }

  return Math.trunc(parsed);
}

function PlanBanner({ plan }) {
  const { t } = useTranslation();

  if (!plan) {
    return null;
  }

  if (!plan.active) {
    return (
      <s-banner
        heading={t("planBanner.inactiveTitle", {
          defaultValue: "Plan Inactive",
        })}
        tone="warning"
      >
        <s-paragraph>
          {t("planBanner.inactiveMessage", {
            defaultValue:
              "Your plan is currently inactive. Choose a plan to continue.",
          })}
        </s-paragraph>

        <s-button
          slot="primary-action"
          href="/plans"
        >
          {t("planBanner.choosePlan", {
            defaultValue: "Choose Plan",
          })}
        </s-button>
      </s-banner>
    );
  }

  if (plan.unlimitedEdits) {
    return null;
  }

  const currentEditCount = parseNonNegativeInteger(
    plan.currentEditCount,
  );
  const maxEdits = parseNonNegativeInteger(
    plan.maxEdits,
  );
  const maxProductsPerEdit = parseNonNegativeInteger(
    plan.maxProductsPerEdit,
  );

  if (
    currentEditCount === null ||
    maxEdits === null ||
    maxEdits === 0 ||
    maxProductsPerEdit === null
  ) {
    return null;
  }

  const editLimitReached =
    currentEditCount >= maxEdits;

  const usageRatio = currentEditCount / maxEdits;
  const approachingLimit =
    !editLimitReached &&
    usageRatio >= USAGE_WARNING_THRESHOLD;

  if (!editLimitReached && !approachingLimit) {
    return null;
  }

  return (
    <s-banner
      heading={t(
        editLimitReached
          ? "planBanner.limitReachedTitle"
          : "planBanner.limitApproachingTitle",
        {
          defaultValue: editLimitReached
            ? "Free Plan Limit Reached"
            : "Approaching Plan Limit",
        },
      )}
      tone={editLimitReached ? "critical" : "warning"}
    >
      <s-paragraph>
        {t(
          editLimitReached
            ? "planBanner.limitReachedMessage"
            : "planBanner.limitApproachingMessage",
          {
            current: currentEditCount,
            maximum: maxEdits,
            products: maxProductsPerEdit,
            defaultValue: editLimitReached
              ? "You've reached your free plan limit! ({{current}}/{{maximum}} edits)."
              : "Free Plan: {{current}}/{{maximum}} edits used. Approaching limit.",
          },
        )}
      </s-paragraph>

      <s-button
        slot="primary-action"
        href="/plans"
      >
        {t(
          editLimitReached
            ? "planBanner.upgradeNow"
            : "planBanner.viewPlans",
          {
            defaultValue: editLimitReached
              ? "Upgrade Now"
              : "View Plans",
          },
        )}
      </s-button>
    </s-banner>
  );
}

export default PlanBanner;