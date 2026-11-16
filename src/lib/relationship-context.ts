/**
 * What the LinkedIn deep read learned about one relationship, in the one shape every surface
 * reads (docs/superpowers/specs/2026-11-15-linkedin-deep-read-design.md, PR 4): chat and Cosmo,
 * drafts, Radar's notes and the contact page.
 *
 * Every value is other people's words or a model's reading of them. The renderer makes each
 * line one capped line; callers place the block inside their existing fence, never a system
 * prompt. Deep read off: the loader returns nothing, so every caller renders as before.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
  contactExperiences,
  contacts,
  relationshipDigests,
  type DatePrecision,
  type RelationshipKind,
} from "@/db/schema";
import { cleanSingleLine } from "@/lib/ai-security";
import { loadYouCurrent } from "@/lib/career-profile-server";
import { deepReadOn } from "@/lib/deep-read";
import { historyOverlaps, overlapLine, type OverlapExperience } from "@/lib/history-overlap";

export type RelationshipContext = {
  origin: { text: string; when: string | null; excerpt: string } | null;
  /** Null when there is none, or the user removed it. */
  kind: RelationshipKind | null;
  overlaps: string[];
  topics: string[];
  workingOn: string | null;
  openThreads: string[];
};

const LINE_MAX = 240;
const MAX_TOPICS = 6;
const MAX_THREADS = 4;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sep 17, 2022" | "Sep 2022" | "2022": only the precision the message gave, never a made-up day. */
export function formatOriginWhen(date: string | null, precision: DatePrecision | null): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? "");
  if (!m || !precision) return null;
  const [, y, mo, d] = m;
  if (precision === "year") return y;
  if (precision === "month") return `${MONTHS[Number(mo) - 1]} ${y}`;
  return `${MONTHS[Number(mo) - 1]} ${Number(d)}, ${y}`;
}

export function renderRelationshipBlock(ctx: RelationshipContext | null | undefined): string | null {
  if (!ctx) return null;
  const lines = [
    ctx.origin ? `How you met: ${ctx.origin.text}${ctx.origin.when ? ` (${ctx.origin.when})` : ""}` : null,
    ctx.kind ? `Relationship: ${ctx.kind}` : null,
    ctx.overlaps.length ? `You overlapped: ${ctx.overlaps.join("; ")}` : null,
    ctx.topics.length ? `You talk about: ${ctx.topics.join(", ")}` : null,
    ctx.workingOn ? `Working on: ${ctx.workingOn}` : null,
    ctx.openThreads.length ? `Open: ${ctx.openThreads.join("; ")}` : null,
  ]
    .map((l) => (l ? cleanSingleLine(l, LINE_MAX) : null))
    .filter((l): l is string => Boolean(l));
  return lines.length ? lines.join("\n") : null;
}

export async function loadRelationshipContexts(
  userId: string,
  contactIds: readonly string[],
  opts: { deepRead?: boolean; now?: Date } = {}
): Promise<Map<string, RelationshipContext>> {
  const out = new Map<string, RelationshipContext>();
  const ids = [...new Set(contactIds)];
  if (!ids.length) return out;
  const deepRead = opts.deepRead ?? (await deepReadOn(userId).catch(() => false));
  if (!deepRead) return out;

  const db = await getDb();
  const [digests, people, you, rows] = await Promise.all([
    db
      .select({
        contactId: relationshipDigests.contactId,
        origin: relationshipDigests.origin,
        relationship: relationshipDigests.relationship,
        topics: relationshipDigests.topics,
        workingOn: relationshipDigests.workingOn,
        openThreads: relationshipDigests.openThreads,
      })
      .from(relationshipDigests)
      .where(and(eq(relationshipDigests.userId, userId), inArray(relationshipDigests.contactId, ids))),
    db
      .select({ id: contacts.id, company: contacts.company, school: contacts.school })
      .from(contacts)
      .where(and(eq(contacts.userId, userId), inArray(contacts.id, ids))),
    loadYouCurrent(userId),
    db
      .select({
        contactId: contactExperiences.contactId,
        kind: contactExperiences.kind,
        organization: contactExperiences.organization,
        startYear: contactExperiences.startYear,
        endYear: contactExperiences.endYear,
        isCurrent: contactExperiences.isCurrent,
      })
      .from(contactExperiences)
      .where(and(eq(contactExperiences.userId, userId), inArray(contactExperiences.contactId, ids))),
  ]);

  const mine = { positions: you.career?.positions, education: you.career?.education, schools: you.schools };
  const hasHistory = Boolean(mine.positions?.length || mine.education?.length || mine.schools.length);
  const theirs = new Map<string, OverlapExperience[]>();
  for (const { contactId, ...e } of rows) theirs.set(contactId, [...(theirs.get(contactId) ?? []), e]);
  const digestOf = new Map(digests.map((d) => [d.contactId, d]));
  const nowYear = (opts.now ?? new Date()).getUTCFullYear();
  const plain = (kind: OverlapExperience["kind"], organization: string | null): OverlapExperience[] =>
    organization ? [{ kind, organization, startYear: null, endYear: null, isCurrent: false }] : [];

  for (const p of people) {
    const d = digestOf.get(p.id);
    const them = theirs.get(p.id) ?? [...plain("role", p.company), ...plain("education", p.school)];
    out.set(p.id, {
      origin: d?.origin
        ? { text: d.origin.text, when: formatOriginWhen(d.origin.date, d.origin.precision), excerpt: d.origin.excerpt }
        : null,
      kind: d?.relationship && !d.relationship.removed ? d.relationship.kind : null,
      overlaps: hasHistory ? historyOverlaps(mine, them, nowYear).map(overlapLine) : [],
      topics: (d?.topics ?? []).map((t) => t.label).slice(0, MAX_TOPICS),
      workingOn: d?.workingOn ?? null,
      openThreads: (d?.openThreads ?? []).map((t) => t.text).slice(0, MAX_THREADS),
    });
  }
  return out;
}
