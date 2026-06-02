import React from "react";
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
      const routeLabel = this.props.routePath || "this page";
      return (
        <Page title="Something went wrong">
          <Card>
            <Box padding="500">
              <BlockStack gap="300">
                <Banner tone="critical">
                  <p>Unable to render {routeLabel}. You can retry or go back safely.</p>
                  {this.state.errorMessage ? (
                    <p>{this.state.errorMessage}</p>
                  ) : null}
                </Banner>
                <InlineStack gap="200">
                  <Button variant="primary" onClick={this.handleRetry}>
                    Retry
                  </Button>
                  <Button onClick={this.props.onBack}>
                    Back
                  </Button>
                </InlineStack>
                <Text as="p" tone="subdued" variant="bodySm">
                  The rest of the app shell is still active.
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
  return (
    <AppRouteErrorBoundaryInner
      routePath={routePath}
      onBack={() => navigate(-1)}
    >
      {children}
    </AppRouteErrorBoundaryInner>
  );
}

