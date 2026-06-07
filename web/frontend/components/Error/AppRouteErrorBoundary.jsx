import React from "react";
import { BlockStack, Box, Card, Page, Text } from "@shopify/polaris";
import DegradationBanner from "../DegradationBanner";

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
    this.retryTimer = window.setTimeout(this.handleRetry, 30_000);
  }

  handleRetry = () => {
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.setState({ hasError: false, errorMessage: "" });
  };

  componentWillUnmount() {
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
  }

  render() {
    if (this.state.hasError) {
      const routeLabel = this.props.routePath || "this page";
      return (
        <Page title="Bulk edit paused">
          <Card>
            <Box padding="500">
              <BlockStack gap="300">
                <DegradationBanner fallbackCode="JOB_SUSPENDED" tone="warning" />
                <Text as="p" tone="subdued" variant="bodySm">
                  {routeLabel} will retry automatically in 30 seconds. No action needed.
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
  return (
    <AppRouteErrorBoundaryInner routePath={routePath}>
      {children}
    </AppRouteErrorBoundaryInner>
  );
}
