import { useState } from "react";
import { Check, Copy, PenLine } from "lucide-react";
import type { ConversationStarter, StartersDegradedReason } from "@contract";
import { cn } from "@/lib/cn";
import { MicroLabel } from "./ui";

/**
 * One blanket "from your notes" caption used to cover three different reasons
 * a starter degraded — misleading for a transient AI failure, and unexplained
 * for "no key configured" (a fixable state, unlike the other two).
 */
function degradedCaption(reason: StartersDegradedReason | null | undefined): string {
  switch (reason) {
    case "ai_error":
      return "couldn't reach AI right now";
    case "no_api_key":
      return "AI features are off";
    case "no_signal":
    default:
      return "from your notes";
  }
}

/**
 * Suggestions, with the fact they came from stated above them.
 *
 * Two deliberate departures from the first draft:
 *
 * - **No "thinking" spinner.** A pulsing sparkle plus the word "thinking" is
 *   anthropomorphism in a panel that stays open all session. A 1px hairline
 *   running under the label is indeterminate, honest, silent, and costs no
 *   height.
 * - **Degraded AI is a source credit, not an apology.** `WHAT TO SAY · FROM
 *   YOUR NOTES` reads as provenance — the same move the per-starter basis line
 *   already makes — rather than as a downgrade the user should feel bad about.
 */
function StarterCard({
  starter,
  onLog,
}: {
  starter: ConversationStarter;
  onLog?: (text: string) => void;
}) {
  const [flashed, setFlashed] = useState<"copy" | "log" | null>(null);

  const flash = (which: "copy" | "log") => {
    setFlashed(which);
    setTimeout(() => setFlashed(null), 1600);
  };

  return (
    <li className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-2.5">
      <p className="mb-1 text-[11px] leading-snug text-[var(--muted-foreground)]">
        {starter.basis}
      </p>
      <p className="text-[13px] leading-[18px] text-[var(--foreground)]">
        {starter.text}
      </p>
      <div className="mt-1.5 flex items-center justify-end gap-1">
        <button
          onClick={() => {
            void navigator.clipboard.writeText(starter.text);
            flash("copy");
          }}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
        >
          {flashed === "copy" ? <Check size={11} /> : <Copy size={11} />}
          {flashed === "copy" ? "Copied" : "Copy"}
        </button>
        {onLog ? (
          // Copying an opener and separately remembering to log it is the seam
          // where a networking CRM leaks. One button closes it.
          <button
            onClick={() => {
              void navigator.clipboard.writeText(starter.text);
              onLog(starter.text);
              flash("log");
            }}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--primary)] hover:bg-[var(--accent)]"
          >
            {flashed === "log" ? <Check size={11} /> : <PenLine size={11} />}
            {flashed === "log" ? "Logged" : "Copy & log"}
          </button>
        ) : null}
      </div>
    </li>
  );
}

export function StarterList({
  starters,
  loading,
  degraded,
  degradedReason,
  // Capture calls this "Opening lines" (you haven't met/logged them — the
  // frame is "how do I start"); Known Contact calls it "What to say"
  // (continuing a relationship). Same component, deliberately different
  // titles per call site — don't "fix" the difference by merging them.
  title = "What to say",
  onLog,
  limit = 2,
}: {
  starters: ConversationStarter[];
  loading: boolean;
  degraded: boolean;
  degradedReason?: StartersDegradedReason | null;
  title?: string;
  onLog?: (text: string) => void;
  limit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  if (starters.length === 0 && !loading) return null;

  const shown = expanded ? starters : starters.slice(0, limit);
  const rest = starters.length - shown.length;

  return (
    <div>
      <div className="mb-1.5">
        <MicroLabel>
          {title}
          {degraded && !loading ? (
            <span className="text-[var(--muted-foreground)]">
              {` · ${degradedCaption(degradedReason)}`}
            </span>
          ) : null}
        </MicroLabel>
        <div className="mt-1 h-px w-full overflow-hidden bg-[var(--border)]">
          <div
            className={cn(
              "h-full bg-[var(--primary)] transition-[width,opacity] ease-out",
              loading ? "w-full opacity-100" : "w-0 opacity-0"
            )}
            style={{ transitionDuration: loading ? "2500ms" : "180ms" }}
          />
        </div>
      </div>

      <ul className="space-y-1.5">
        {shown.map((starter) => (
          <StarterCard key={starter.id} starter={starter} onLog={onLog} />
        ))}
        {loading && starters.length === 0 ? (
          <>
            {/* Height matched to a real two-line card so nothing moves on arrival. */}
            <li className="h-[86px] rounded-[var(--radius)] bg-[var(--muted)]" />
            <li className="h-[86px] rounded-[var(--radius)] bg-[var(--muted)]" />
          </>
        ) : null}
      </ul>

      {rest > 0 ? (
        <button
          onClick={() => setExpanded(true)}
          className="mt-1.5 text-[11px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          {rest} more
        </button>
      ) : null}
    </div>
  );
}
