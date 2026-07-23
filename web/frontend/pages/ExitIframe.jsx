import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { Banner, BlockStack, Box, Button, Layout, Page, Spinner } from "@shopify/polaris";
import { useTranslation } from "react-i18next";
import { useEmbeddedRedirect } from "../hooks/useEmbeddedRedirect";

export default function ExitIframe() {
  const { t } = useTranslation(["common"]);
  const { redirectRemote } = useEmbeddedRedirect();
  const { search } = useLocation();
  const [showWarning, setShowWarning] = useState(false);
  const [redirectUri, setRedirectUri] = useState(null);

  useEffect(() => {
    window.shopify?.loading?.(true);
    try {
      const params = new URLSearchParams(search);
      const nextRedirectUri = params.get("redirectUri");
      if (!nextRedirectUri) {
        setShowWarning(true);
        return;
      }
      const url = new URL(decodeURIComponent(nextRedirectUri));

      if (
        [location.hostname, "admin.shopify.com"].includes(url.hostname) ||
        url.hostname.endsWith(".myshopify.com")
      ) {
        setRedirectUri(url.toString());
        redirectRemote(url.toString());
      } else {
        setShowWarning(true);
      }
    } catch {
      setShowWarning(true);
    } finally {
      window.shopify?.loading?.(false);
    }
  }, [search, setShowWarning, redirectRemote]);

  if (showWarning) {
    return (
    <Page narrowWidth>
      <Layout>
        <Layout.Section>
          <Box paddingBlockStart="1600">
            <Banner
              title={t("exitIframeWarningTitle", {
                defaultValue: "Redirecting outside of Shopify",
              })}
              tone="warning"
            >
              {t("exitIframeWarningBody", {
                defaultValue: "Apps can only use /exitiframe to reach Shopify or the app itself.",
              })}
            </Banner>
          </Box>
        </Layout.Section>
      </Layout>
    </Page>
    );
  }

  return (
    <Page narrowWidth>
      <Layout>
        <Layout.Section>
          <Box paddingBlockStart="1600">
            <BlockStack inlineAlign="center" gap="300">
            <Spinner
              accessibilityLabel={t("redirecting", { defaultValue: "Redirecting" })}
              size="large"
            />
            {redirectUri ? (
              <Box paddingBlockStart="300">
                <Button onClick={() => redirectRemote(redirectUri)}>
                  {t("continue", { defaultValue: "Continue" })}
                </Button>
              </Box>
            ) : null}
            </BlockStack>
          </Box>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
