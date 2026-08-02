import {
  Component,
  type ErrorInfo,
  type ReactNode,
} from "react";

interface CellErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface CellErrorBoundaryState {
  hasError: boolean;
}

class CellErrorBoundary extends Component<
  CellErrorBoundaryProps,
  CellErrorBoundaryState
> {
  state: CellErrorBoundaryState = {
    hasError: false,
  };

  static getDerivedStateFromError(): CellErrorBoundaryState {
    return {
      hasError: true,
    };
  }

  componentDidCatch(
    error: Error,
    errorInfo: ErrorInfo,
  ): void {
    console.error(
      "Cell render failed",
      error,
      errorInfo,
    );
  }

  render(): ReactNode {
    return this.state.hasError
      ? (this.props.fallback ?? "[render error]")
      : this.props.children;
  }
}

export default CellErrorBoundary;
