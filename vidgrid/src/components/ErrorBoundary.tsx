import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw, X } from "lucide-react";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Minimal error boundary that catches rendering errors in child components
 * and displays a recovery UI instead of crashing the entire app.
 *
 * Each TaskCard will be wrapped in an ErrorBoundary so that a single corrupt
 * file or rendering failure doesn't bring down the entire task list.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("[ErrorBoundary] Caught error:", error, errorInfo);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  handleDismiss = (): void => {
    // Dismiss hides the error and unmounts the child by rendering null
    this.setState({ hasError: true, error: null });
  };

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (this.props.fallback) {
      return this.props.fallback;
    }

    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 shrink-0 text-red-400" size={20} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-red-400">
              Something went wrong
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {this.state.error?.message || "An unexpected error occurred"}
            </p>
            <div className="mt-3 flex gap-2">
              <button
                onClick={this.handleReset}
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent"
              >
                <RefreshCw size={12} />
                Retry
              </button>
              <button
                onClick={this.handleDismiss}
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent"
              >
                <X size={12} />
                Dismiss
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
