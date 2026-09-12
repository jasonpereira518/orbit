import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * A popup that throws during render paints nothing at all, and a blank 400px
 * panel gives the user no way to tell "broken" from "still loading". Anything
 * that escapes render gets shown here instead, with the message copyable so it
 * can be pasted into a bug report without opening devtools.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[orbit] popup crashed", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const detail = `${error.message}\n\n${error.stack ?? ""}`.trim();
    return (
      <div className="flex flex-1 flex-col gap-2 p-4">
        <p className="text-[14px] font-medium">Orbit hit an error</p>
        <pre className="scroll-area max-h-48 whitespace-pre-wrap rounded-[var(--radius)] bg-[var(--muted)] p-2 text-[11px] leading-snug text-[var(--muted-foreground)]">
          {detail}
        </pre>
        <div className="flex gap-2">
          <button
            onClick={() => navigator.clipboard.writeText(detail)}
            className="h-8 rounded-[var(--radius)] border border-[var(--border)] px-3 text-[12px]"
          >
            Copy details
          </button>
          <button
            onClick={() => this.setState({ error: null })}
            className="h-8 rounded-[var(--radius)] bg-[var(--primary)] px-3 text-[12px] text-[var(--primary-foreground)]"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
