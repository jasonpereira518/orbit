/**
 * Where the user's own work and school history meets a contact's: "you were both at Acme,
 * 2021 to 2023". Pure and DB-free, so the engine prompt, closeness and the contact page can all
 * call it on rows they already loaded.
 *
 * Organizations match on `normalizeCompanyKey`, the key "who worked at X" already uses. Years
 * are only claimed when both sides have them and the ranges meet; otherwise the shared place
 * is still reported, without "together".
 */
import type { CareerEducation, CareerPosition } from "@/db/schema";
import { normalizeCompanyKey } from "@/lib/company-name";

/** One row of a contact's history, shaped like `contact_experiences`. */
export type OverlapExperience = {
  kind: "role" | "education";
  organization: string;
  startYear: number | null;
  endYear: number | null;
  isCurrent: boolean;
};

export type HistoryOverlap = {
  kind: "work" | "school";
  /** As written on the user's side. */
  organization: string;
  /** True only when both sides have years and the ranges share at least one year. */
  together: boolean;
  /** The shared years when `together`, else null. */
  fromYear: number | null;
  toYear: number | null;
};

/** Legal-form words that say nothing about which organization it is. */
const SUFFIXES = new Set(["inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "co", "company", "plc", "gmbh", "ag", "sa", "llp", "lp"]);

/**
 * `normalizeCompanyKey` with trailing legal forms dropped, so "Acme, Inc." meets "Acme".
 * ponytail: suffixes only; aliases ("UNC" vs "University of North Carolina") need a lookup table.
 */
function orgKey(name: string): string {
  const words = normalizeCompanyKey(name).split(" ").filter(Boolean);
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.length === 1 && SUFFIXES.has(words[0]) ? "" : words.join(" ");
}

type Range = { from: number; to: number } | null;
type Side = { kind: HistoryOverlap["kind"]; organization: string; key: string; range: Range };

/** A start year with no end runs to `openEnd` (today for a current role, else the start year). */
function rangeOf(start: number | null | undefined, end: number | null | undefined, openEnd: number | null): Range {
  if (!start) return null;
  const to = end ?? openEnd ?? start;
  return to >= start ? { from: start, to } : null;
}

export function historyOverlaps(
  you: { positions?: CareerPosition[]; education?: CareerEducation[]; schools?: string[] },
  them: readonly OverlapExperience[],
  nowYear: number,
): HistoryOverlap[] {
  const mine: Side[] = [
    // A position with no end date is the current one (`CareerPosition.end`).
    ...(you.positions ?? []).map((p) => ({
      kind: "work" as const,
      organization: p.company,
      key: orgKey(p.company),
      range: rangeOf(p.start?.year, p.end?.year, nowYear),
    })),
    ...(you.education ?? []).map((e) => ({
      kind: "school" as const,
      organization: e.school,
      key: orgKey(e.school),
      range: rangeOf(e.start?.year, e.end?.year, null),
    })),
    // Schools typed in Settings carry no years.
    ...(you.schools ?? []).map((s) => ({ kind: "school" as const, organization: s, key: orgKey(s), range: null })),
  ].filter((s) => s.key);

  const best = new Map<string, HistoryOverlap>();
  for (const t of them) {
    const key = orgKey(t.organization);
    if (!key) continue;
    const kind = t.kind === "role" ? "work" : "school";
    const theirs = rangeOf(t.startYear, t.endYear, t.isCurrent ? nowYear : null);
    for (const m of mine) {
      if (m.kind !== kind || m.key !== key) continue;
      const from = m.range && theirs ? Math.max(m.range.from, theirs.from) : null;
      const to = m.range && theirs ? Math.min(m.range.to, theirs.to) : null;
      const together = from !== null && to !== null && from <= to;
      const found: HistoryOverlap = {
        kind,
        organization: m.organization,
        together,
        fromYear: together ? from : null,
        toYear: together ? to : null,
      };
      const id = `${kind}:${key}`;
      const prev = best.get(id);
      if (!prev || better(found, prev)) best.set(id, found);
    }
  }
  return [...best.values()];
}

/** "Together" beats "same place, other years"; between two "together", the longer stretch wins. */
function better(a: HistoryOverlap, b: HistoryOverlap): boolean {
  if (a.together !== b.together) return a.together;
  if (!a.together) return false;
  return a.toYear! - a.fromYear! > b.toYear! - b.fromYear!;
}
