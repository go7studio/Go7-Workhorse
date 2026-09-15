import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: string | null; stack: string | null; gen: number };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: null, gen: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error: error.message || "Something went wrong", stack: error.stack ?? null };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("workhorse render failed", error, info.componentStack);
    const stack = [info.componentStack, error.stack].filter(Boolean).join("\n") || null;
    this.setState((current) => (current.stack === stack ? current : { ...current, stack }));
  }

  componentDidMount() {
    import.meta.hot?.on("vite:afterUpdate", () => {
      this.setState((current) => ({ error: null, stack: null, gen: current.gen + 1 }));
    });
  }

  render() {
    if (this.state.error) {
      return (
        <div className="crash">
          <h1>Workhorse hit a snag</h1>
          <p>{this.state.error}</p>
          {this.state.stack ? <pre className="crash-stack">{this.state.stack.trim()}</pre> : null}
          <button type="button" onClick={() => this.setState((current) => ({ error: null, stack: null, gen: current.gen + 1 }))}>
            Try again
          </button>
        </div>
      );
    }
    return <Fragment key={this.state.gen}>{this.props.children}</Fragment>;
  }
}
