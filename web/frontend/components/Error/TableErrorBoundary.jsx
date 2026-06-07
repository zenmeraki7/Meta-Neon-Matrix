import React from "react";
import { Box } from "@shopify/polaris";
import DegradationBanner from "../DegradationBanner";

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
    this.retryTimer = window.setTimeout(this.handleRetry, 30_000);
  }

  handleRetry = () => {
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.setState({ hasError: false });
  };

  componentWillUnmount() {
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
  }

  render() {
    if (this.state.hasError) {
      return (
        <Box padding="400">
          <DegradationBanner fallbackCode="JOB_SUSPENDED" tone="warning" />
        </Box>
      );
    }

    return this.props.children;
  }
}

export default TableErrorBoundary;
