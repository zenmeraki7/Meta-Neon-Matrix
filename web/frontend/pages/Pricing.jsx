import React, { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Divider,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { getDefaultPricingPlans } from "../Domain/Subscription/config/pricingPlans";
import { useApiClient } from "../hooks/useApiClient";
import { useEmbeddedRedirect } from "../hooks/useEmbeddedRedirect";
import { toSafeErrorMessage } from "../utils/frontendError";
import { getShopifyContext } from "../utils/shopifyContext";

const PLAN_BADGES = {
  FREE: { label: "Current plan", tone: "success" },
  STARTER: { label: "Current plan", tone: "success" },
  BASIC_MONTHLY: { label: "Standard", tone: "new" },
  ADVANCED_MONTHLY: { label: "Most popular", tone: "info" },
  PRO_MONTHLY: { label: "Best for scale", tone: "attention" },
  PROFESSIONAL_MONTHLY: { label: "Best for scale", tone: "attention" },
};

const PLAN_DESCRIPTIONS = {
  FREE: "For small stores getting started with basic bulk editing.",
  STARTER: "For small stores getting started with basic bulk editing.",
  BASIC_MONTHLY: "For stores that need faster bulk editing workflows.",
  ADVANCED_MONTHLY: "For growing stores with recurring catalog operations.",
  PRO_MONTHLY: "For teams managing high-volume catalog operations.",
  PROFESSIONAL_MONTHLY: "For teams managing high-volume catalog operations.",
};

const PLAN_CTA_LABELS = {
  FREE: "Current plan",
  STARTER: "Current plan",
  BASIC_MONTHLY: "Choose Basic",
  ADVANCED_MONTHLY: "Choose Advanced",
  PRO_MONTHLY: "Choose Pro",
  PROFESSIONAL_MONTHLY: "Choose Pro",
};

const BILLING_PLAN_BY_PRICING_KEY = {
  BASIC_MONTHLY: "basic",
  ADVANCED_MONTHLY: "advanced",
  PRO_MONTHLY: "pro",
  PROFESSIONAL_MONTHLY: "pro",
};

function PricingCard({ plan, isSubscribing, onSelectPlan, t, planText }) {
  const features = Array.isArray(plan.features) ? plan.features : [];
  const badge = PLAN_BADGES[plan.key] || { label: "Standard", tone: "new" };
  const description = PLAN_DESCRIPTIONS[plan.key] || plan.description;
  const ctaLabel = PLAN_CTA_LABELS[plan.key] || plan.buttonText;
  const isFree = plan.isFree === true || plan.price == null || Number(plan.price) === 0;

  return (
    <Card>
      <Box padding="500">
        <BlockStack gap="500">
          <BlockStack gap="300">
            <Text variant="headingLg" as="h2">
              {planText(plan.name)}
            </Text>

            <InlineStack align="start">
              <Badge tone={badge.tone}>{t(badge.label, { defaultValue: badge.label })}</Badge>
            </InlineStack>

            <Text as="p" tone="subdued">
              {planText(description)}
            </Text>
          </BlockStack>

          <BlockStack gap="200">
            {isFree ? (
              <Text variant="heading3xl" as="p" fontWeight="bold">
                {t("FreePrice", { defaultValue: "Free" })}
              </Text>
            ) : (
              <InlineStack align="start" blockAlign="end" gap="200" wrap={false}>
                <Text variant="heading3xl" as="p" fontWeight="bold">
                  ${plan.price}
                </Text>
                <Box paddingBlockEnd="100">
                  <Text variant="bodyMd" as="p" tone="subdued">
                    / {t("PerMonth", { defaultValue: "month" })}
                  </Text>
                </Box>
              </InlineStack>
            )}

            <Text variant="bodySm" as="p" tone="subdued">
              {isFree
                ? t("NoMonthlyCharge", { defaultValue: "No monthly charge" })
                : t("BilledEveryThirtyDays", { defaultValue: "Billed every 30 days" })}
            </Text>
          </BlockStack>

          <Button
            variant={plan.isCurrent ? "secondary" : plan.buttonVariant}
            fullWidth
            loading={isSubscribing}
            disabled={plan.isCurrent || isSubscribing}
            onClick={() => onSelectPlan(plan)}
          >
            {plan.isCurrent
              ? t("CurrentPlan", { defaultValue: "Current plan" })
              : t(ctaLabel, { defaultValue: ctaLabel })}
          </Button>

          <Divider />

          <BlockStack gap="300">
            <Text variant="headingMd" as="h3">
              {t("WhatsIncluded", { defaultValue: "What's included" })}
            </Text>
            <BlockStack gap="300">
              {features.map((feature) => (
                <InlineStack key={feature} gap="300" blockAlign="start" wrap={false}>
                  <Text variant="bodyMd" as="span" tone="success">
                    {"\u2713"}
                  </Text>
                  <Text variant="bodyMd" as="p">
                    {planText(feature)}
                  </Text>
                </InlineStack>
              ))}
            </BlockStack>
          </BlockStack>
        </BlockStack>
      </Box>
    </Card>
  );
}

export default function PricingPage() {
  const navigate = useNavigate();
  const { t } = useTranslation(["subscription", "common"]);
  const api = useApiClient();
  const { redirectRemote } = useEmbeddedRedirect();
  const [plans, setPlans] = useState(() => getDefaultPricingPlans());
  const [billingError, setBillingError] = useState(null);
  const [subscribing, setSubscribing] = useState(null);

  const planText = useCallback((value) => String(value || "").trim(), []);

  const loadAuthoritativePlans = useCallback(async () => {
    const response = await api.get("/api/subscription/get-plans");
    const data = response?.data ?? response;
    if (Array.isArray(data?.plans)) {
      setPlans(data.plans);
    }
    return data;
  }, [api]);

  useEffect(() => {
    const { host } = getShopifyContext();
    console.info("Pricing page mounted", {
      hasHost: Boolean(host),
    });

    let cancelled = false;
    (async () => {
      try {
        const syncResponse = await api.post("/api/billing/sync", null, {
          idempotent: true,
        });
        console.info("Billing sync completed", {
          synced: Boolean(syncResponse?.synced),
          planKey: syncResponse?.planKey || null,
          mock: Boolean(syncResponse?.mock),
        });

        if (!cancelled) {
          await loadAuthoritativePlans();
        }
      } catch (err) {
        console.warn("Billing sync/load failed", {
          code: err?.payload?.code || err?.code || null,
          message: err?.message || String(err),
        });
        if (!cancelled) {
          try {
            await loadAuthoritativePlans();
          } catch (loadErr) {
            console.warn("Billing plan load failed", {
              code: loadErr?.payload?.code || loadErr?.code || null,
              message: loadErr?.message || String(loadErr),
            });
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, loadAuthoritativePlans]);

  const handleSelectPlan = async (plan) => {
    if (plan.isCurrent) {
      return;
    }

    try {
      setBillingError(null);
      setSubscribing(plan.key);

      const billingPlan = BILLING_PLAN_BY_PRICING_KEY[plan.key];
      if (!billingPlan) {
        throw new Error(
          t("invalidBillingPlan", {
            defaultValue: "This plan cannot be purchased from the pricing page.",
          }),
        );
      }

      console.info("Billing plan selected", {
        pricingPlanKey: plan.key,
        billingPlan,
      });
      const response = await api.post(
        "/api/billing/subscribe",
        { plan: billingPlan },
        { idempotent: true },
      );
      const data = response?.data ?? response;

      if (!data?.ok && !data?.success) {
        throw new Error(
          data?.message ||
            t("subscriptionFailed", { defaultValue: "Subscription failed" }),
        );
      }

      if (data.mock === true) {
        const refreshed = await loadAuthoritativePlans();
        if (!Array.isArray(refreshed?.plans)) {
          setPlans((currentPlans) =>
            currentPlans.map((currentPlan) => ({
              ...currentPlan,
              isCurrent: currentPlan.key === plan.key,
            })),
          );
        }
        setBillingError(data.message || null);
        return;
      }

      if (!data.confirmationUrl) {
        throw new Error(
          data?.message ||
            t("billingConfirmationMissing", {
              defaultValue: "Shopify did not return a billing approval URL.",
            }),
        );
      }

      console.info("Redirecting to Shopify billing approval", {
        plan: billingPlan,
        confirmationUrlPresent: Boolean(data.confirmationUrl),
      });
      redirectRemote(data.confirmationUrl);
    } catch (err) {
      console.error("Subscription error:", err);
      const billingUnavailableMessage =
        err?.payload?.code === "BILLING_API_UNAVAILABLE"
          ? err.payload.message
          : null;
      setBillingError(
        billingUnavailableMessage ||
        (err?.code === "AUTH_FETCH_UNAVAILABLE"
          ? t("billingAuthUnavailable", {
              defaultValue:
                "Billing could not start because the embedded app session is not ready. Please reload the app.",
            })
          : toSafeErrorMessage(t, err, "common.errors.generic")),
      );
    } finally {
      setSubscribing(null);
    }
  };

  const visiblePlans = Array.isArray(plans) ? plans : getDefaultPricingPlans();

  return (
    <Page
      title={t("pricingPageTitle", { defaultValue: "Pricing" })}
      subtitle={t("pricingPageSubtitle", {
        defaultValue: "Choose a plan that fits your store's bulk editing needs.",
      })}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="500">
            <Text as="p" tone="subdued">
              {t("pricingBillingNote", {
                defaultValue:
                  "All charges are billed in USD. Recurring charges are billed every 30 days.",
              })}
            </Text>

            {billingError ? (
              <Banner tone="warning" onDismiss={() => setBillingError(null)}>
                <p>{billingError}</p>
              </Banner>
            ) : null}

            <InlineGrid columns={{ xs: 1, sm: 2, md: 2, lg: 4 }} gap="500">
              {visiblePlans.map((plan) => {
                const isSubscribing = subscribing === plan.key;

                return (
                  <PricingCard
                    key={plan.key}
                    plan={plan}
                    isSubscribing={isSubscribing}
                    onSelectPlan={handleSelectPlan}
                    t={t}
                    planText={planText}
                  />
                );
              })}
            </InlineGrid>
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          <Box paddingBlockStart="400" paddingBlockEnd="800">
            <Card>
              <Box padding="600">
                <BlockStack gap="400" inlineAlign="center">
                  <BlockStack gap="200" inlineAlign="center">
                    <Text variant="headingLg" as="h3" alignment="center">
                      {t("StillHaveQuestions", { defaultValue: "Still have questions?" })}
                    </Text>
                    <Text variant="bodyMd" as="p" tone="subdued" alignment="center">
                      {t("SupportHelpChoosePlan", {
                        defaultValue:
                          "Our support team can help you choose the right plan.",
                      })}
                    </Text>
                  </BlockStack>
                  <Button
                    variant="primary"
                    size="large"
                    onClick={() => navigate("/suggestionpage")}
                  >
                    {t("ContactSupport", { defaultValue: "Contact support" })}
                  </Button>
                </BlockStack>
              </Box>
            </Card>
          </Box>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
