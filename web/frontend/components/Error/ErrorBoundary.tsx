// web/frontend/components/ErrorBoundary.tsx
import React, { Component, ErrorInfo, ReactNode } from 'react';
import { protectedApiPost } from '../../api/protectedApiClient';
import styles from './ErrorBoundary.module.css';
import DegradationBanner from '../DegradationBanner';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  context?: string; // e.g. "Export Table" or "Dashboard" for a more descriptive message
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
  retryCount: number;
  reported: boolean;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  private retryTimer?: number;

  public state: ErrorBoundaryState = {
    hasError: false,
    error: undefined,
    retryCount: 0,
    reported: false,
  };

  // Called when a child throws—sets the error state
  public static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  // Called after the error is thrown; we log/report once here
  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error in ErrorBoundary:', error, errorInfo);

    // Only report once per error instance
    if (
      import.meta.env.PROD &&
      this.state.hasError &&
      !this.state.reported
    ) {
      this.reportError(error, errorInfo);
      this.setState({ reported: true });
    }
    this.retryTimer = window.setTimeout(this.retry, 30_000);
  }

  // Retry button handler
  public retry = () => {
    this.setState((prev: ErrorBoundaryState): ErrorBoundaryState => {
      const nextCount = prev.retryCount + 1;
      return { 
        hasError: false, 
        error: undefined, 
        retryCount: nextCount, 
        reported: false 
      };
    });
  };

  public componentWillUnmount() {
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
  }

  // Report to your own logging endpoint
  private async reportError(error: Error, errorInfo: ErrorInfo) {
    try {
      await protectedApiPost('/api/log-error', {
          message: error.message,
          stack: error.stack,
          componentInlineStack: errorInfo.componentInlineStack,
          context: this.props.context || 'Unknown context',
          retryCount: this.state.retryCount,
          timestamp: new Date().toISOString(),
          userAgent: navigator.userAgent,
      });
    } catch (e) {
      // Never throw from within componentDidCatch
      console.warn('Failed to report error:', e);
    }
  }

  public render() {
    const { children, fallback } = this.props;
    const { hasError, error } = this.state;
    const isDev = import.meta.env.DEV;

    if (hasError) {
      // If a custom fallback is provided, render it (no retry button shown)
      if (fallback) {
        return <>{fallback}</>;
      }

      return (
        <>
          <DegradationBanner fallbackCode="JOB_SUSPENDED" tone="warning" />
            {isDev && error && (
              <details>
                <summary className={styles.errorSummary}>
                  Error Details (Dev Only)
                </summary>
                <pre className={styles.errorStack}>
                  {error.stack}
                </pre>
              </details>
            )}
        </>
      );
    }

    return <>{children}</>;
  }
}

export default ErrorBoundary;
