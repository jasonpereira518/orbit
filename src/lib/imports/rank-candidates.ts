/**
 * Which of a folder's importable files matter most.
 *
 * A folder pick used to stage the biggest file of each kind and quietly set the rest aside, so
 * a Downloads folder holding three contacts files, a `Connections (1).csv` and a stale backup
 * imported whichever was largest and said nothing about the others. This scores every
 * recognised file so the review can pre-tick the best one per kind, say why, and let the person
 * swap it.
 *
 * Pure: no React, no DOM. The score is a sort key, not a promise — the person always has the
 * last word in the review.
 */
import type { Detected, ImportTarget } from "@/lib/imports/detect-import-file";

/** What a kind is worth on its own: the people list first, calendars last. */
const TARGET_WEIGHT: Partial<Record<ImportTarget, number>> = {
  linkedin_connections: 25,
  contacts_file: 20,
  linkedin_messages: 15,
  calendar_ics: 10,
  calendar_csv: 10,
};

/** Names that say "not the real one": copies, backups, samples. */
const LOW_VALUE_NAME = /(\bcopy\b|\(\d+\)|\bbackup\b|\bold\b|\barchive\b|\btest\b|\bsample\b|\btemplate\b|\bexample\b)/i;

/** Under this a file is a header and nothing else — a one-event calendar is already past it. */
const NEARLY_EMPTY_BYTES = 64;

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export type RankedCandidate = {
  detected: Detected;
  score: number;
  /** Short, shown next to the file: "Your LinkedIn export · biggest · recent". */
  why: string;
  /** The best of its kind and worth ticking. */
  suggested: boolean;
};

function baseName(d: Detected): string {
  return d.displayName || d.file.name;
}

export function scoreCandidate(d: Detected, now = Date.now()): { score: number; notes: string[] } {
  const notes: string[] = [];
  let score = d.confidence === "certain" ? 60 : d.confidence === "likely" ? 40 : 20;
  if (d.confidence === "certain") notes.push("named exactly as expected");
  score += TARGET_WEIGHT[d.target] ?? 0;

  if (LOW_VALUE_NAME.test(baseName(d))) {
    score -= 30;
    notes.push("looks like a copy or backup");
  }
  if (d.bytes < NEARLY_EMPTY_BYTES) {
    score -= 30;
    notes.push("almost empty");
  } else {
    // Log scale: ten times the data is worth a fixed step, not ten times the score.
    score += Math.min(20, Math.log10(d.bytes) * 4);
  }
  const modified = d.file.lastModified;
  if (modified && now - modified < ONE_YEAR_MS) {
    score += 10;
    notes.push("recent");
  }
  return { score, notes };
}

/**
 * Every candidate, best first, with the best of each kind marked suggested.
 *
 * One suggestion per kind because the import engine runs one file per kind. A file that scores
 * as a near-empty copy is never suggested, even when it is the only one of its kind — ticking
 * it for the person would be a guess they did not ask for — but it is still listed.
 */
export function rankCandidates(candidates: readonly Detected[], now = Date.now()): RankedCandidate[] {
  const scored = candidates.map((detected) => {
    const { score, notes } = scoreCandidate(detected, now);
    return { detected, score, notes };
  });
  scored.sort((a, b) => b.score - a.score);

  const claimed = new Set<ImportTarget>();
  return scored.map(({ detected, score, notes }) => {
    const poor = detected.bytes < NEARLY_EMPTY_BYTES;
    const suggested = !poor && !claimed.has(detected.target);
    if (suggested) claimed.add(detected.target);
    const why = [detected.reason, ...notes].join(" · ");
    return { detected, score, why, suggested };
  });
}
