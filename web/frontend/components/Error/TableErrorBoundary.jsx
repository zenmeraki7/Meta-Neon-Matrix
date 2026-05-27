import React from "react";
import { Banner, Box, Button, InlineStack } from "@shopify/polaris";

class TableErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    console.error("Table boundary error:", error);
  }

  handleRetry = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        <Box padding="400">
          <Banner tone="critical">
            <p>Table render failed.</p>
            <InlineStack gap="200">
              <Button size="slim" onClick={this.handleRetry}>
                Retry table
              </Button>
            </InlineStack>
          </Banner>
        </Box>
      );
    }

    return this.props.children;
  }
}

export default TableErrorBoundary;

