import type { MatchCandidate } from "@contract";
import { Avatar, Button } from "../components/ui";

/**
 * One possible person, shared between Ambiguous (server-detected matches) and
 * Capture's duplicate-on-save band (candidates a failed create returned) — one
 * visual pattern for "here's who this might be" instead of two.
 */
export function CandidateRow({
  candidate,
  onPick,
}: {
  candidate: MatchCandidate;
  onPick: (candidate: MatchCandidate) => void;
}) {
  const strong = candidate.confidence >= 0.9;
  return (
    <button
      onClick={() => onPick(candidate)}
      className="group flex w-full items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-2.5 text-left hover:bg-[var(--accent)]"
    >
      <Avatar name={candidate.fullName} size={32} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{candidate.fullName}</p>
        <p className="truncate text-[11px] text-[var(--muted-foreground)]">
          {[candidate.title, candidate.company].filter(Boolean).join(" · ") ||
            "No role saved"}
        </p>
        <p className="mt-0.5 text-[11px] text-[var(--muted-foreground)]">
          {candidate.reason}
        </p>
      </div>
      {/* Same swap-on-hover language as RecordRow's Provenance dot. */}
      <span className="relative flex h-[11px] w-[70px] shrink-0 items-center justify-end">
        <span
          aria-hidden
          className="absolute right-0 h-2 w-2 rounded-full opacity-100 transition-opacity group-hover:opacity-0"
          style={{ background: strong ? "var(--primary)" : "var(--border)" }}
        />
        <span className="absolute right-0 truncate text-[10px] text-[var(--muted-foreground)] opacity-0 transition-opacity group-hover:opacity-100">
          {strong ? "strong match" : "possible match"}
        </span>
      </span>
    </button>
  );
}

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
    <div className="scroll-area flex-1 space-y-3 px-3 py-3">
      <div>
        <h2 className="text-[14px] font-medium">Is this someone you know?</h2>
        <p className="mt-0.5 text-[12px] text-[var(--muted-foreground)]">
          Orbit found {candidates.length === 1 ? "a possible match" : "a few possible matches"}.
        </p>
      </div>

      <ul className="space-y-2">
        {candidates.map((candidate) => (
          <li key={candidate.id}>
            <CandidateRow candidate={candidate} onPick={onPick} />
          </li>
        ))}
      </ul>

      <Button variant="ghost" className="w-full" onClick={onCreateNew}>
        No — add as a new person
      </Button>
    </div>
  );
}
