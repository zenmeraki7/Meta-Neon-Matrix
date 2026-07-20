// web/frontend/components/ErrorBoundary.tsx

import React, { Component, type ErrorInfo, type ReactNode } from "react";

import {
  Banner,
  BlockStack,
  Box,
  Button,
  Collapsible,
  Text,
} from "@shopify/polaris";
import { protectedApiPost } from "../../api/protectedApiClient";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  context?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
  retryCount: number;
  reported: boolean;
  errorDetailsOpen: boolean;
}

const MAX_RETRY_ATTEMPTS = 3;

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public state: ErrorBoundaryState = {
    hasError: false,
    error: undefined,
    retryCount: 0,
    reported: false,
    errorDetailsOpen: false,
  };

  public static getDerivedStateFromError(
    error: Error,
  ): Partial<ErrorBoundaryState> {
    return {
      hasError: true,
      error,
      errorDetailsOpen: false,
    };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("Uncaught error in ErrorBoundary:", error, errorInfo);

    if (import.meta.env.PROD && !this.state.reported) {
      this.setState({ reported: true });

      void this.reportError(error, errorInfo);
    }
  }

  public retry = (): void => {
    this.setState((previousState): ErrorBoundaryState => {
      if (previousState.retryCount >= MAX_RETRY_ATTEMPTS) {
        return {
          ...previousState,
          errorDetailsOpen: false,
        };
      }

      return {
        hasError: false,
        error: undefined,
        retryCount: previousState.retryCount + 1,
        reported: false,
        errorDetailsOpen: false,
      };
    });
  };

  private toggleErrorDetails = (): void => {
    this.setState((previousState) => ({
      errorDetailsOpen: !previousState.errorDetailsOpen,
    }));
  };

  private async reportError(error: Error, errorInfo: ErrorInfo): Promise<void> {
    try {
      await protectedApiPost("/api/log-error", {
        message: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack,
        context: this.props.context ?? "Unknown context",
        retryCount: this.state.retryCount,
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent,
      });
    } catch (reportingError) {
      console.warn("Failed to report error:", reportingError);
    }
  }

  public render(): ReactNode {
    const { children, fallback, context } = this.props;

    const { hasError, error, retryCount, errorDetailsOpen } = this.state;

    if (!hasError) {
      return <>{children}</>;
    }

    if (fallback) {
      return <>{fallback}</>;
    }

    const canRetry = retryCount < MAX_RETRY_ATTEMPTS;

    const isDevelopment = import.meta.env.DEV;

    const contextMessage = context
      ? `An error occurred in "${context}". Please try again.`
      : "An unexpected error occurred. Please try again.";

    const errorDetailsId = "error-boundary-development-details";

    const errorDetails =
      error?.stack ?? error?.message ?? "No error details are available.";

    return (
      <Banner
        tone="critical"
        action={
          canRetry
            ? {
                content: `Try again (${retryCount + 1}/${MAX_RETRY_ATTEMPTS})`,
                onAction: this.retry,
              }
            : undefined
        }
      >
        <BlockStack gap="200">
          <Text as="p" variant="bodyMd">
            {contextMessage}
          </Text>

          {!canRetry ? (
            <Text as="p" variant="bodySm" tone="subdued">
              You have reached the maximum retry attempts. Please refresh the
              page or contact support.
            </Text>
          ) : null}

          {isDevelopment && error ? (
            <BlockStack gap="200">
              <Button
                variant="plain"
                textAlign="left"
                disclosure={errorDetailsOpen ? "up" : "down"}
                onClick={this.toggleErrorDetails}
                ariaExpanded={errorDetailsOpen}
                ariaControls={errorDetailsId}
              >
                Error details (development only)
              </Button>

              <Collapsible
                id={errorDetailsId}
                open={errorDetailsOpen}
                transition={{
                  duration: "200ms",
                  timingFunction: "ease-in-out",
                }}
                expandOnPrint
              >
                <Box
                  background="bg-surface-secondary"
                  borderRadius="200"
                  padding="400"
                >
                  <Text as="p" variant="bodySm" breakWord>
                    {errorDetails}
                  </Text>
                </Box>
              </Collapsible>
            </BlockStack>
          ) : null}
        </BlockStack>
      </Banner>
    );
  }
}

export default ErrorBoundary;
