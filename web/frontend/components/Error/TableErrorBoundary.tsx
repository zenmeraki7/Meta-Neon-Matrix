import {
  Component,
  type ErrorInfo,
  type ReactNode,
} from "react";

interface TableErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface TableErrorBoundaryState {
  hasError: boolean;
}

class TableErrorBoundary extends Component<
  TableErrorBoundaryProps,
  TableErrorBoundaryState
> {
  state: TableErrorBoundaryState = {
    hasError: false,
  };

  static getDerivedStateFromError(): TableErrorBoundaryState {
    return {
      hasError: true,
    };
  }

  componentDidCatch(
    error: Error,
    errorInfo: ErrorInfo,
  ): void {
    console.error(
      "Table render failed",
      error,
      errorInfo,
    );
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <s-banner
            tone="critical"
            heading="Table could not be displayed"
          >
            <s-paragraph>
              Refresh the page and try again.
            </s-paragraph>
          </s-banner>
        )
      );
    }

    return this.props.children;
  }
}

export default TableErrorBoundary;
