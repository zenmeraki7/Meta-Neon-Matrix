import React, { useState, useEffect, useCallback } from "react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Badge,
  Divider,
  Box,
  Icon,
  Collapsible,
  Spinner,
  Layout,
  Modal,
} from "@shopify/polaris";
import { CheckIcon } from "@shopify/polaris-icons";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { protectedApiPost } from "../api/protectedApiClient";
import { subscriptionService } from "../Domain/Subscription/services/subscriptionService";
import { toSafeErrorMessage } from "../utils/frontendError";

const DEFAULT_PRICING_PLANS = Object.freeze([
  {
    key: "FREE",
    name: "Free Plan",
    price: 0,
    compareAtPrice: null,
    isFree: true,
    description: "Perfect for trying out our app",
    highlight: "Get started with essential features",
    popular: false,
    features: ["Basic features", "Up to 100 products", "Email support"],
    buttonText: "Get Started",
    buttonVariant: "primary",
  },
  {
    key: "ADVANCED_MONTHLY",
    name: "Advanced Monthly",
    price: 3,
    compareAtPrice: 10,
    isFree: false,
    description: "For growing businesses",
    highlight: "Everything you need to scale",
    popular: true,
    features: [
      "All Free features",
      "Up to 1,000 products - Manual Edits",
      "Up to 1,000 products - Scheduled Edits",
    ],
    buttonText: "Upgrade to Advanced",
    buttonVariant: "primary",
  },
  {
    key: "PRO_MONTHLY",
    name: "Pro Monthly",
    price: 5,
    compareAtPrice: 18,
    isFree: false,
    description: "For established stores",
    highlight: "Premium features and dedicated support",
    popular: false,
    features: [
      "All Advanced features",
      "Unlimited products",
      "Unlimited Scheduled Edit",
    ],
    buttonText: "Start Pro",
    buttonVariant: "primary",
  },
]);

function redirectToBilling(url) {
  if (!url) return;

  try {
    window.open(url, "_top");
  } catch {
    window.location.href = url;
  }
}

export default function PricingPage() {
  const navigate = useNavigate();
  const { t } = useTranslation("subscription");

  const [openFaqIndex, setOpenFaqIndex] = useState(null);
  const [showFreeModal, setShowFreeModal] = useState(false);
  const [selectedFreePlan, setSelectedFreePlan] = useState(null);
  const [plans, setPlans] = useState(DEFAULT_PRICING_PLANS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [subscribing, setSubscribing] = useState(null);

  const fetchPlans = useCallback(async () => {
    setLoading(true);

    try {
      const data = await subscriptionService.getSubscriptionPlans();

      const livePlans = Array.isArray(data?.plans)
        ? data.plans.filter((plan) => plan && plan.key)
        : [];

      if (data?.success && livePlans.length > 0) {
        setPlans(livePlans);
        setError(null);
        return;
      }

      setError(
        t("pricingLoadPlansError", {
          defaultValue: "Showing default pricing because live plans failed to load.",
        }),
      );
    } catch (err) {
      console.error("Error fetching plans:", err);
      setError(toSafeErrorMessage(t, err, "common.errors.generic"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchPlans();
  }, [fetchPlans]);

  const faqs = [
    {
      question: t("faqQuestion1", {
        defaultValue: "Can I change my plan later?",
      }),
      answer: t("faqAnswer1", {
        defaultValue:
          "Yes. You can upgrade or change your plan as your store grows.",
      }),
    },
    {
      question: t("faqQuestion2", {
        defaultValue: "Is there a free plan?",
      }),
      answer: t("faqAnswer2", {
        defaultValue:
          "Yes. The free plan is available for stores that need essential features.",
      }),
    },
    {
      question: t("faqQuestion3", {
        defaultValue: "How does billing work?",
      }),
      answer: t("faqAnswer3", {
        defaultValue: "Paid plans are billed through Shopify billing.",
      }),
    },
    {
      question: t("faqQuestion4", {
        defaultValue: "What happens if plan data cannot load?",
      }),
      answer: t("faqAnswer4", {
        defaultValue:
          "Default pricing remains visible while the app retries live plan data.",
      }),
    },
    {
      question: t("faqQuestion5", {
        defaultValue: "Can I contact support?",
      }),
      answer: t("faqAnswer5", {
        defaultValue: "Yes. Contact support if you need help choosing a plan.",
      }),
    },
  ];

  const toggleFaq = (index) => {
    setOpenFaqIndex((currentIndex) => (currentIndex === index ? null : index));
  };

  const handleSelectPlan = async (plan) => {
    try {
      setSubscribing(plan.key);

      const data = await protectedApiPost(
        "/api/subscription/create-subscription",
        {
          planKey: plan.key,
          returnUrl: `${window.location.origin}/pricing`,
        },
        {
          idempotent: true,
        },
      );

      if (!data?.success) {
        throw new Error(
          data?.message ||
            t("subscriptionFailed", {
              defaultValue: "Subscription failed",
            }),
        );
      }

      if (!data.confirmationUrl) {
        setSubscribing(null);
        await fetchPlans();
        return;
      }

      redirectToBilling(data.confirmationUrl);
    } catch (err) {
      console.error("Subscription error:", err);
      setError(toSafeErrorMessage(t, err, "common.errors.generic"));
      setSubscribing(null);
    }
  };

  return (
    <Page
      title={t("pricingPageTitle", { defaultValue: "Pricing" })}
      subtitle={t("pricingPageSubtitle", {
        defaultValue: "Choose the plan that fits your store.",
      })}
    >
      <Layout>
        {error ? (
          <Layout.Section>
            <Card>
              <Box padding="400">
                <InlineStack
                  align="space-between"
                  blockAlign="center"
                  gap="300"
                  wrap
                >
                  <InlineStack gap="200" blockAlign="center">
                    {loading ? <Spinner size="small" /> : null}
                    <Text as="p" tone="subdued">
                      {error}
                    </Text>
                  </InlineStack>

                  <Button onClick={fetchPlans} disabled={loading}>
                    {t("Retry", { defaultValue: "Retry" })}
                  </Button>
                </InlineStack>
              </Box>
            </Card>
          </Layout.Section>
        ) : null}

        {loading && !error ? (
          <Layout.Section>
            <InlineStack gap="200" blockAlign="center">
              <Spinner size="small" />
              <Text as="p" tone="subdued">
                {t("LoadingPlans", { defaultValue: "Loading plans" })}
              </Text>
            </InlineStack>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: "20px",
              alignItems: "stretch",
            }}
          >
            {plans.map((plan) => {
              const features = Array.isArray(plan.features)
                ? plan.features
                : [];

              return (
                <Card key={plan.key}>
                  <Box padding="400">
                    <BlockStack gap="400">
                      <InlineStack
                        align="space-between"
                        blockAlign="center"
                        gap="200"
                      >
                        {plan.popular ? (
                          <Badge tone="info">
                            {t("MostPopular", {
                              defaultValue: "Most popular",
                            })}
                          </Badge>
                        ) : (
                          <span />
                        )}

                        {plan.isCurrent ? (
                          <Badge tone="success">
                            {t("CurrentPlan", {
                              defaultValue: "Current plan",
                            })}
                          </Badge>
                        ) : null}
                      </InlineStack>

                      <BlockStack gap="200">
                        <Text variant="headingXl" as="h2">
                          {t(plan.name, { defaultValue: plan.name })}
                        </Text>

                        <Text variant="bodyMd" as="p" tone="subdued">
                          {t(plan.description, {
                            defaultValue: plan.description,
                          })}
                        </Text>
                      </BlockStack>

                      <BlockStack gap="200">
                        <InlineStack align="start" blockAlign="end" gap="200">
                          <Text variant="heading3xl" as="p" fontWeight="bold">
                            ${plan.price}
                          </Text>

                          {plan.compareAtPrice &&
                          plan.compareAtPrice > plan.price ? (
                            <Text variant="headingMd" as="p" tone="subdued">
                              <span
                                style={{
                                  textDecoration: "line-through",
                                  opacity: 0.7,
                                }}
                              >
                                ${plan.compareAtPrice}
                              </span>
                            </Text>
                          ) : null}

                          <Text variant="headingMd" as="p" tone="subdued">
                            {t("PerMonth", { defaultValue: "/ month" })}
                          </Text>
                        </InlineStack>

                        {plan.isFree ? (
                          <Badge tone="success">
                            {t("FreeForever", {
                              defaultValue: "Free forever",
                            })}
                          </Badge>
                        ) : (
                          <Text variant="bodySm" as="p" tone="subdued">
                            {t(plan.highlight, {
                              defaultValue: plan.highlight,
                            })}
                          </Text>
                        )}
                      </BlockStack>

                      <Button
                        variant={plan.isCurrent ? "primary" : plan.buttonVariant}
                        size="large"
                        fullWidth
                        disabled={plan.isCurrent || subscribing === plan.key}
                        onClick={() => {
                          if (plan.isFree) {
                            setSelectedFreePlan(plan);
                            setShowFreeModal(true);
                          } else {
                            void handleSelectPlan(plan);
                          }
                        }}
                      >
                        {subscribing === plan.key ? (
                          <InlineStack gap="200" align="center">
                            <Spinner size="small" />
                            <Text as="span">
                              {t("Processing", {
                                defaultValue: "Processing",
                              })}
                            </Text>
                          </InlineStack>
                        ) : plan.isCurrent ? (
                          t("CurrentPlan", { defaultValue: "Current plan" })
                        ) : (
                          t(plan.buttonText, {
                            defaultValue: plan.buttonText,
                          })
                        )}
                      </Button>

                      <Divider />

                      <BlockStack gap="300">
                        <Text variant="headingMd" as="h3">
                          {t("WhatsIncluded", {
                            defaultValue: "What's included",
                          })}
                        </Text>

                        <BlockStack gap="300">
                          {features.map((feature, featureIndex) => (
                            <InlineStack
                              key={`${plan.key}-${featureIndex}`}
                              gap="300"
                              blockAlign="start"
                              wrap={false}
                            >
                              <div style={{ minWidth: 20 }}>
                                <Icon source={CheckIcon} tone="success" />
                              </div>

                              <Text variant="bodyMd" as="p">
                                {t(feature, { defaultValue: feature })}
                              </Text>
                            </InlineStack>
                          ))}
                        </BlockStack>
                      </BlockStack>
                    </BlockStack>
                  </Box>
                </Card>
              );
            })}
          </div>
        </Layout.Section>

        <Layout.Section>
          <Box paddingBlockStart="800" paddingBlockEnd="400">
            <BlockStack gap="600" inlineAlign="center">
              <BlockStack gap="300" inlineAlign="center">
                <Text variant="heading2xl" as="h2" alignment="center">
                  {t("FrequentlyAskedQuestions", {
                    defaultValue: "Frequently asked questions",
                  })}
                </Text>

                <div style={{ maxWidth: 600 }}>
                  <Text
                    variant="bodyLg"
                    as="p"
                    tone="subdued"
                    alignment="center"
                  >
                    {t("PlansAndBillingHelpText", {
                      defaultValue: "Find answers about plans and billing.",
                    })}
                  </Text>
                </div>
              </BlockStack>

              <div style={{ width: "100%", maxWidth: 800 }}>
                <BlockStack gap="300">
                  {faqs.map((faq, index) => (
                    <Card key={index}>
                      <Box padding="400">
                        <Button
                          variant="plain"
                          textAlign="left"
                          fullWidth
                          onClick={() => toggleFaq(index)}
                          disclosure={openFaqIndex === index ? "up" : "down"}
                        >
                          <Text variant="headingMd" as="h3">
                            {faq.question}
                          </Text>
                        </Button>

                        <Collapsible
                          open={openFaqIndex === index}
                          id={`faq-${index}`}
                          transition={{
                            duration: "200ms",
                            timingFunction: "ease-in-out",
                          }}
                        >
                          <Box paddingBlockStart="400">
                            <Divider />

                            <Box paddingBlockStart="400">
                              <Text variant="bodyMd" as="p" tone="subdued">
                                {faq.answer}
                              </Text>
                            </Box>
                          </Box>
                        </Collapsible>
                      </Box>
                    </Card>
                  ))}
                </BlockStack>
              </div>
            </BlockStack>
          </Box>
        </Layout.Section>

        <Layout.Section>
          <Box paddingBlockStart="400" paddingBlockEnd="800">
            <Card>
              <Box padding="600">
                <BlockStack gap="400" inlineAlign="center">
                  <BlockStack gap="200" inlineAlign="center">
                    <Text variant="headingLg" as="h3" alignment="center">
                      {t("StillHaveQuestions", {
                        defaultValue: "Still have questions?",
                      })}
                    </Text>

                    <Text
                      variant="bodyMd"
                      as="p"
                      tone="subdued"
                      alignment="center"
                    >
                      {t("SupportHelpChoosePlan", {
                        defaultValue:
                          "Support can help you choose the right plan.",
                      })}
                    </Text>
                  </BlockStack>

                  <InlineStack gap="300" align="center">
                    <Button
                      variant="primary"
                      size="large"
                      onClick={() => navigate("/suggestionpage")}
                    >
                      {t("ContactSupport", {
                        defaultValue: "Contact support",
                      })}
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Box>
            </Card>
          </Box>
        </Layout.Section>
      </Layout>

      <Modal
        open={showFreeModal}
        onClose={() => setShowFreeModal(false)}
        title={t("activateFreePlanTitle", {
          defaultValue: "Activate Free Plan?",
        })}
        primaryAction={{
          content: t("Confirm", { defaultValue: "Confirm" }),
          onAction: async () => {
            setShowFreeModal(false);

            if (selectedFreePlan) {
              await handleSelectPlan(selectedFreePlan);
            }
          },
        }}
        secondaryActions={[
          {
            content: t("Cancel", { defaultValue: "Cancel" }),
            onAction: () => setShowFreeModal(false),
          },
        ]}
      >
        <Box padding="400">
          <Text variant="bodyMd" as="p">
            {t("FreePlanActivationLine1", {
              defaultValue: "You are about to activate the free plan.",
            })}
            <br />
            <br />
            {t("FreePlanActivationLine2", {
              defaultValue:
                "Your current plan will be updated after confirmation.",
            })}
            <br />
            <br />
            {t("FreePlanActivationLine3", {
              defaultValue: "You can upgrade again any time.",
            })}
          </Text>
        </Box>
      </Modal>
    </Page>
  );
}