import { and, desc, eq, gt } from "drizzle-orm";
import { getDb } from "@/db";
import { interactions, relationshipDigests } from "@/db/schema";
import type { SnapshotRole } from "@/lib/job-changes";
import { fenceUntrusted } from "@/lib/ai-security";

/**
 * What Jev reads before a work-history search (spec 2026-11-10-jev-work-history-design.md).
 *
 * The re-check gate reads what Orbit already knows about where someone works and what it has
 * heard from or about them since the last check — summaries of the user's notes and messages
 * (Jason, Nov 10), trimmed, and never the raw note, an email address or a phone number.
 */
export const WORK_HISTORY_GATE_LIMITS = {
  interactions: 10,
  summaryChars: 300,
  digestChars: 300,
  firstAnswerChars: 2000,
} as const;

const DAY_MS = 86_400_000;

function trim(text: string | null | undefined, max: number): string | null {
  const t = text?.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

function monthsBetween(year: number, month: number, now: Date): number {
  return Math.max(0, (now.getUTCFullYear() - year) * 12 + (now.getUTCMonth() + 1 - month));
}

export type RecheckGateInput = {
  roles: SnapshotRole[];
  title: string | null;
  company: string | null;
  closenessTier: string | null;
  lastCheckedAt: Date;
  now: Date;
  /** Interactions dated after `lastCheckedAt`; filtered, ordered and capped here as well. */
  interactions: Array<{ type: string; date: Date; summary: string | null }>;
  digest: { whatTheyDo: string | null; workingOn: string | null } | null;
};

/** The re-check gate's state from rows already read — pure, so the label export can share it. */
export function shapeRecheckGateState(input: RecheckGateInput): Record<string, unknown> {
  const L = WORK_HISTORY_GATE_LIMITS;
  const recent = input.interactions
    .filter((i) => i.date.getTime() > input.lastCheckedAt.getTime())
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, L.interactions);
  return {
    contact: {
      title: input.title,
      company: input.company,
      closeness_tier: input.closenessTier,
      current_roles: input.roles
        .filter((r) => r.isCurrent)
        .map((r) => ({
          organization: r.organization,
          title: r.title,
          started: r.startYear ? `${r.startYear}-${String(r.startMonth ?? 1).padStart(2, "0")}` : null,
          tenure_months: r.startYear ? monthsBetween(r.startYear, r.startMonth ?? 1, input.now) : null,
        })),
    },
    last_checked: {
      date: input.lastCheckedAt.toISOString().slice(0, 10),
      days_ago: Math.floor((input.now.getTime() - input.lastCheckedAt.getTime()) / DAY_MS),
    },
    since_last_check: {
      interactions: recent.map((i) => ({
        type: i.type,
        date: i.date.toISOString().slice(0, 10),
        summary: trim(i.summary, L.summaryChars),
      })),
      what_they_do: trim(input.digest?.whatTheyDo, L.digestChars),
      working_on: trim(input.digest?.workingOn, L.digestChars),
    },
  };
}

/**
 * The verify-veto gate's state: Orbit's facts about the contact, the first search's answer
 * (public web text, fenced as untrusted and capped), and — on a re-check that found a new
 * employer — where they moved, so a stale stored company does not read as "someone else".
 */
export function verifyGateState(
  subject: { fullName: string; title: string | null; company: string | null; location: string | null; school: string | null; linkedinUrl: string | null },
  firstAnswerJson: string,
  movedTo: { organization: string; title: string | null } | null,
): Record<string, unknown> {
  return {
    contact: {
      name: subject.fullName,
      title: subject.title,
      company: subject.company,
      location: subject.location,
      school: subject.school,
      linkedin_url: subject.linkedinUrl,
    },
    first_answer: fenceUntrusted("first_answer", firstAnswerJson.slice(0, WORK_HISTORY_GATE_LIMITS.firstAnswerChars)),
    ...(movedTo ? { moved_to: { organization: movedTo.organization, title: movedTo.title } } : {}),
  };
}

/** The re-check gate's state for one contact: two small reads, then `shapeRecheckGateState`. */
export async function recheckGateState(
  userId: string,
  contactId: string,
  args: Omit<RecheckGateInput, "interactions" | "digest">,
): Promise<Record<string, unknown>> {
  const db = await getDb();
  const [rows, digest] = await Promise.all([
    db
      .select({ type: interactions.interactionType, date: interactions.interactionDate, summary: interactions.aiSummary })
      .from(interactions)
      .where(
        and(
          eq(interactions.userId, userId),
          eq(interactions.contactId, contactId),
          gt(interactions.interactionDate, args.lastCheckedAt),
        ),
      )
      .orderBy(desc(interactions.interactionDate))
      .limit(WORK_HISTORY_GATE_LIMITS.interactions),
    db.query.relationshipDigests.findFirst({
      where: and(eq(relationshipDigests.userId, userId), eq(relationshipDigests.contactId, contactId)),
      columns: { whatTheyDo: true, workingOn: true },
    }),
  ]);
  return shapeRecheckGateState({ ...args, interactions: rows, digest: digest ?? null });
}
