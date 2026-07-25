import React from "react";
import { useTranslation } from "react-i18next";
import { Banner, Box, Button, InlineStack } from "@shopify/polaris";

const POLARIS_PROPS = Object.freeze({
  criticalTone: "critical",
  slimSize: "slim",
});

class TableErrorBoundaryInner extends React.Component {
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
      const { t } = this.props;

      return (
        <Box padding="400">
          <Banner tone={POLARIS_PROPS.criticalTone}>
            <p>{t("tableError.renderFailed")}</p>
            <InlineStack gap="200">
              <Button size={POLARIS_PROPS.slimSize} onClick={this.handleRetry}>
                {t("tableError.retry")}
              </Button>
            </InlineStack>
          </Banner>
        </Box>
      );
    }

    return this.props.children;
  }
}

export default function TableErrorBoundary({ children }) {
  const { t } = useTranslation();

  return <TableErrorBoundaryInner t={t}>{children}</TableErrorBoundaryInner>;
}
