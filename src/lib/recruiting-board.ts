import { canonicalCompanyClusterName } from "@/lib/company-family";
import { normalizeCompanyName } from "@/lib/company-name";
import { isRecruiterStage, mergeStage, type RecruiterStage, type StageObservation } from "@/lib/recruiter-stages";

/**
 * The Recruiting board: one card per company, folded from what email insights found.
 *
 * A view, not a store. `email_events` already holds every stage change the sweep read (by
 * rule from application-system mail, by the person's own AI for the rest); this groups them by
 * company and lets the person correct the result. Pure — no database — so the page, the
 * actions and the smoke all share one rule for what a card says.
 */

/** Legal-entity suffixes, stripped from the key only. Strictly legal: "labs" or "group" would over-merge. */
const LEGAL_SUFFIX_RE =
  /\s+(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|gmbh|plc|ag|bv|nv|sa|srl|oy|ab|pty|pte|kk)$/;

/**
 * The key events fold into one company by. Stronger than `normalizeCompanyName` on purpose: a
 * model naming one employer "Stripe" in one thread and "Stripe, Inc." in the next is the normal
 * case, and the spaces go too, so a Workday tenant's "capitalone" meets a recruiter's "Capital
 * One". Aliases ("Meta Platforms" → Meta) come from the constellation's table; its family key
 * would fold DeepMind into Google, which for a job search are two companies.
 */
export function companyKey(raw: string): string {
  let key = normalizeCompanyName(canonicalCompanyClusterName(raw) ?? raw)
    .replace(/[.,]/g, "")
    .replace(/^the\s+/, "")
    .trim();
  // Twice, so "Foo Co., Ltd." reduces fully.
  key = key.replace(LEGAL_SUFFIX_RE, "").replace(LEGAL_SUFFIX_RE, "").trim();
  return key.replace(/[^a-z0-9]/g, "");
}

/**
 * Board columns in pipeline order — the order of `STAGE_RANK`, so a card only ever moves right.
 * `in_conversation` shares Screening's column rather than opening the board: it outranks
 * `applied`, and a recruiter writing back after an application is progress, not a step back.
 */
export const BOARD_COLUMNS = [
  { id: "reached_out", label: "Reached out", stages: ["outreach_received", "outreach_sent"] },
  { id: "applied", label: "Applied", stages: ["applied"] },
  { id: "screening", label: "Screening", stages: ["in_conversation", "screening"] },
  { id: "interviewing", label: "Interviewing", stages: ["interviewing"] },
  { id: "offer", label: "Offer", stages: ["offer"] },
  { id: "closed", label: "Closed", stages: ["rejected", "withdrawn"] },
] as const satisfies readonly { id: string; label: string; stages: readonly RecruiterStage[] }[];

export type BoardColumnId = (typeof BOARD_COLUMNS)[number]["id"];

export function columnFor(stage: RecruiterStage): BoardColumnId {
  const column = BOARD_COLUMNS.find((c) => (c.stages as readonly RecruiterStage[]).includes(stage));
  return column?.id ?? "reached_out";
}

/** The slice of an `email_events` row the board reads, joined to its thread's Gmail id. */
export type BoardEvent = {
  company: string | null;
  role: string | null;
  stage: string | null;
  occurredAt: Date;
  source: "rule" | "ai";
  summary: string;
  threadId: string;
};

export type BoardOverride = {
  companyKey: string;
  hiddenAt: Date | null;
  stage: RecruiterStage | null;
  stageAt: Date | null;
};

export type BoardCompany = {
  key: string;
  name: string;
  stage: RecruiterStage;
  /** Whether the stage on the card is the person's own — it holds until newer mail arrives. */
  stageSetByYou: boolean;
  roles: string[];
  lastActivityAt: Date;
  /** The newest sentence the person's AI wrote about it. Rule events say nothing a stage does not. */
  summary: string | null;
  /** The newest thread, for "Open in Gmail". */
  threadId: string;
};

const MAX_ROLES = 6;

/**
 * Events and corrections in, cards out.
 *
 * - **Stage** is `mergeStage` over the company's events by date: progress only moves forward,
 *   and a rejection or withdrawal wins only from its own date on.
 * - **A stage set by hand** starts the fold at the moment it was set, so mail dated before it
 *   cannot move it and mail after it can — a person who marks a company "Withdrawn" and then
 *   gets an interview invite sees the invite.
 * - **Hidden** companies are returned apart and stay hidden whatever arrives: only "Put it
 *   back" clears the override.
 */
export function foldCompanies(
  events: readonly BoardEvent[],
  overrides: readonly BoardOverride[]
): { companies: BoardCompany[]; hidden: BoardCompany[] } {
  const byKey = new Map<string, BoardEvent[]>();
  for (const event of events) {
    if (!event.company || !event.stage || !isRecruiterStage(event.stage)) continue;
    const key = companyKey(event.company);
    if (!key) continue;
    const list = byKey.get(key);
    if (list) list.push(event);
    else byKey.set(key, [event]);
  }
  const overrideByKey = new Map(overrides.map((o) => [o.companyKey, o]));

  const companies: BoardCompany[] = [];
  const hidden: BoardCompany[] = [];
  for (const [key, list] of byKey) {
    list.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const override = overrideByKey.get(key);

    let current: StageObservation | null =
      override?.stage && override.stageAt ? { stage: override.stage, at: override.stageAt } : null;
    const held = current;
    for (const event of list) {
      if (held && event.occurredAt <= held.at) continue; // older than the person's own word
      current = mergeStage(current, { stage: event.stage as RecruiterStage, at: event.occurredAt });
    }
    if (!current) continue;

    const latest = list[list.length - 1];
    // The model's spelling reads better than a sender-domain label ("Wells Fargo", not "Wellsfargo").
    const named = [...list].reverse().find((e) => e.source === "ai" && e.company) ?? latest;
    const roles: string[] = [];
    const seen = new Set<string>();
    for (const event of [...list].reverse()) {
      const role = event.role?.trim();
      if (role && !seen.has(role.toLowerCase())) {
        seen.add(role.toLowerCase());
        roles.push(role);
      }
    }

    const card: BoardCompany = {
      key,
      name: (named.company ?? latest.company ?? key).trim(),
      stage: current.stage,
      stageSetByYou: Boolean(held && current.at.getTime() === held.at.getTime()),
      roles: roles.slice(0, MAX_ROLES),
      lastActivityAt: latest.occurredAt,
      summary: [...list].reverse().find((e) => e.source === "ai")?.summary ?? null,
      threadId: latest.threadId,
    };
    (override?.hiddenAt ? hidden : companies).push(card);
  }

  const newestFirst = (a: BoardCompany, b: BoardCompany) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime();
  return { companies: companies.sort(newestFirst), hidden: hidden.sort(newestFirst) };
}

/** Where "Open in Gmail" goes. `#all` finds the thread whichever label it sits under. */
export function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
}
