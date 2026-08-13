import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './Button';

/**
 * Catches a render crash and shows something usable instead of a blank page.
 *
 * React unmounts the entire tree when a render throws, so without this a single
 * bad value anywhere blanks the whole screen — which is exactly what happened
 * when the server's `{ code, message }` warnings were rendered as if they were
 * strings. At a counter with a customer waiting, a white page is the worst
 * possible failure: nothing to read, nothing to press, and no clue whether the
 * bill was saved.
 *
 * A class component because there is still no hook equivalent of
 * `componentDidCatch`.
 */
interface Props {
  children: ReactNode;
  /// Changing this resets the boundary — the route path, so navigating away
  /// from a broken screen clears it.
  resetKey?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(previous: Props) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Kept in the console rather than sent anywhere: there is no error service
    // wired up, and inventing one silently would be worse than saying so.
    console.error('Render failed:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="mx-auto max-w-lg rounded-xl border border-rose-200 bg-rose-50 p-6 text-center dark:border-rose-900/50 dark:bg-rose-950/30">
        <h2 className="text-lg font-semibold text-rose-900 dark:text-rose-200">
          This screen hit a problem
        </h2>
        <p className="mt-2 text-sm text-rose-800 dark:text-rose-300">
          Nothing you were working on was sent to the server, so nothing has been saved or
          changed. Reloading usually clears it.
        </p>

        <div className="mt-4 flex justify-center gap-2">
          <Button variant="secondary" onClick={() => this.setState({ error: null })}>
            Try again
          </Button>
          <Button onClick={() => window.location.reload()}>Reload</Button>
        </div>

        <details className="mt-4 text-left">
          <summary className="cursor-pointer text-xs text-rose-700 dark:text-rose-400">
            Technical detail
          </summary>
          <pre className="mt-2 overflow-x-auto rounded bg-rose-100 p-2 text-xs text-rose-900 dark:bg-rose-950/60 dark:text-rose-200">
            {this.state.error.message}
          </pre>
        </details>
      </div>
    );
  }
}
