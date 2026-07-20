import React from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Banner, BlockStack, Box, Button, Card, InlineStack, Page, Text } from "@shopify/polaris";

class AppRouteErrorBoundaryInner extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, errorMessage: "" };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      errorMessage: error?.message || String(error || "Unknown render error"),
    };
  }

  componentDidCatch(error) {
    // Keep route-level failure isolated without crashing app shell.
    console.error("Route boundary error:", error);
  }

  handleRetry = () => {
    this.setState({ hasError: false, errorMessage: "" });
  };

  render() {
    if (this.state.hasError) {
      const { t } = this.props;
      const routeLabel = this.props.routePath || t("routeError.currentPage");
      return (
        <Page title={t("routeError.title")}>
          <Card>
            <Box padding="500">
              <BlockStack gap="300">
                <Banner tone="critical">
                  <p>{t("routeError.unableToRender", { route: routeLabel })}</p>
                  {this.state.errorMessage ? (
                    <p>{this.state.errorMessage}</p>
                  ) : null}
                </Banner>
                <InlineStack gap="200">
                  <Button variant="primary" onClick={this.handleRetry}>
                    {t("routeError.retry")}
                  </Button>
                  <Button onClick={this.props.onBack}>
                    {t("routeError.back")}
                  </Button>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  {t("routeError.shellActive")}
                </Text>
              </BlockStack>
            </Box>
          </Card>
        </Page>
      );
    }

    return this.props.children;
  }
}

export default function AppRouteErrorBoundary({ children, routePath }) {
  const navigate = useNavigate();
  const { t } = useTranslation();

  return (
    <AppRouteErrorBoundaryInner
      routePath={routePath}
      onBack={() => navigate(-1)}
      t={t}
    >
      {children}
    </AppRouteErrorBoundaryInner>
  );
}

