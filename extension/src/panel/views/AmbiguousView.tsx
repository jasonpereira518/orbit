import type { MatchCandidate } from "@contract";
import { Avatar, Button } from "../components/ui";

/**
 * Picking a candidate shows their record; it does not merge. Viewing someone
 * and claiming "this page is them" are different decisions, and conflating them
 * is how a wrong LinkedIn URL ends up welded to the wrong contact.
 */
export function AmbiguousView({
  candidates,
  onPick,
  onCreateNew,
}: {
  candidates: MatchCandidate[];
  onPick: (candidate: MatchCandidate) => void;
  onCreateNew: () => void;
}) {
  return (
    <div className="scroll-area reveal-stagger flex-1 space-y-3 px-4 py-3">
      <div>
        <h2 className="text-[14px] font-medium">Is this someone you know?</h2>
        <p className="mt-0.5 text-[12px] text-[var(--muted-foreground)]">
          Orbit found {candidates.length === 1 ? "a possible match" : "a few possible matches"}.
        </p>
      </div>

      <ul className="space-y-2">
        {candidates.map((candidate) => (
          <li key={candidate.id}>
            <button
              onClick={() => onPick(candidate)}
              className="flex w-full items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-2.5 text-left hover:bg-[var(--accent)]"
            >
              <Avatar name={candidate.fullName} size={32} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">
                  {candidate.fullName}
                </p>
                <p className="truncate text-[11px] text-[var(--muted-foreground)]">
                  {[candidate.title, candidate.company].filter(Boolean).join(" · ") ||
                    "No role saved"}
                </p>
                <p className="mt-0.5 text-[11px] text-[var(--muted-foreground)]">
                  {candidate.reason}
                </p>
              </div>
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full"
                style={{
                  background:
                    candidate.confidence >= 0.9
                      ? "var(--primary)"
                      : "var(--border)",
                }}
              />
            </button>
          </li>
        ))}
      </ul>

      <Button variant="ghost" className="w-full" onClick={onCreateNew}>
        No — add as a new person
      </Button>
    </div>
  );
}
