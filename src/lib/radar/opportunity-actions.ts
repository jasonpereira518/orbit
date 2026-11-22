/**
 * The Opportunities lane on the Radar page: reading the open finds of the weekly web pass
 * (`opportunities.ts`) and what the person can do with one. Request-free, owner-scoped, so the
 * server actions stay thin and the smoke drives the same code.
 *
 * Nothing here runs unless the person asks: saving is the only way a find becomes an event, a
 * contact or a reminder (spec rule 3, "nothing enters your contacts without you").
 */
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, radarOpportunities } from "@/db/schema";
import { resolveOrCreateContact } from "@/lib/contact-resolve";
import { isLinkedInProfileUrl } from "@/lib/contact-input";
import { findOrCreateEventByLink } from "@/lib/events/discovery/record";
import { resolveThemeColor } from "@/lib/events/theme";
import { createReminderForUser } from "@/lib/reminder-writes";
import { parsePersonTitle } from "@/lib/radar/person-title";
import type { RadarDismissReason, RadarEvidence, RadarOpportunityKind } from "@/lib/radar/types";

const DAY_MS = 86_400_000;
/** At most this many finds on the page at once; the soonest first. */
export const OPPORTUNITIES_SHOWN = 6;
/** A program's reminder lands this long before its deadline (or tomorrow, if that has passed). */
const PROGRAM_REMIND_DAYS = 7;

export type OpportunityView = {
  id: string;
  kind: RadarOpportunityKind;
  title: string;
  url: string | null;
  why: string | null;
  startsAt: string | null;
  expiresAt: string | null;
  evidence: RadarEvidence[];
  /** Someone the person knows who can introduce them (person finds). */
  introducer: { contactId: string; name: string } | null;
};

/** Open finds: not saved, dismissed or past, soonest first. One statement, introducer joined in. */
export async function listOpenOpportunities(userId: string, now: Date = new Date(), limit = OPPORTUNITIES_SHOWN): Promise<OpportunityView[]> {
  const db = await getDb();
  const rows = await db
    .select({ row: radarOpportunities, introName: contacts.fullName })
    .from(radarOpportunities)
    // The introducer is the first related contact; a merged-away or deleted one joins nothing,
    // and the card then names nobody rather than a stale name.
    .leftJoin(contacts, and(eq(contacts.userId, radarOpportunities.userId), sql`${contacts.id} = ${radarOpportunities.relatedContactIds}[1]`))
    .where(
      and(
        eq(radarOpportunities.userId, userId),
        inArray(radarOpportunities.status, ["found", "pending"]),
        or(isNull(radarOpportunities.expiresAt), gt(radarOpportunities.expiresAt, now)),
        or(isNull(radarOpportunities.startsAt), gt(radarOpportunities.startsAt, now))
      )
    )
    .orderBy(asc(sql`coalesce(${radarOpportunities.startsAt}, ${radarOpportunities.expiresAt})`))
    .limit(limit);
  return rows.map(({ row: r, introName }) => {
    const introId = r.relatedContactIds[0];
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      url: r.url,
      why: r.why,
      startsAt: r.startsAt?.toISOString() ?? null,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      evidence: r.evidence,
      introducer: introId && introName ? { contactId: introId, name: introName } : null,
    };
  });
}

async function ownedOpen(userId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const db = await getDb();
  const [row] = await db
    .select()
    .from(radarOpportunities)
    .where(and(eq(radarOpportunities.id, id), eq(radarOpportunities.userId, userId), inArray(radarOpportunities.status, ["found", "pending"])))
    .limit(1);
  return row ?? null;
}

async function setStatus(userId: string, id: string, status: "saved" | "dismissed", dismissReason: string | null = null) {
  const db = await getDb();
  await db
    .update(radarOpportunities)
    .set({ status, dismissReason, updatedAt: new Date() })
    .where(and(eq(radarOpportunities.userId, userId), eq(radarOpportunities.id, id)));
}

export type SaveOpportunityResult =
  | { ok: true; kind: RadarOpportunityKind; message: string; href: string; contactId?: string }
  | { ok: false; message: string };

const GONE = "That find has already changed — refresh to see the latest";

/**
 * Keep a find: an event goes on the Events page, a person becomes a contact, a program becomes a
 * reminder before its deadline. The row is then `saved` and leaves Radar.
 */
export async function saveOpportunityForUser(userId: string, id: string, now: Date = new Date()): Promise<SaveOpportunityResult> {
  const row = await ownedOpen(userId, id);
  if (!row) return { ok: false, message: GONE };
  if (row.kind === "event") {
    const label = row.evidence[0]?.label ?? "";
    const event = await findOrCreateEventByLink(
      userId,
      {
        title: row.title,
        startsAt: row.startsAt,
        venue: label.startsWith("At ") ? label.slice(3) : null,
        url: row.url,
        description: row.why,
        attendanceMode: "offline",
        themeColor: resolveThemeColor({ seed: row.title }).color,
        role: "attended",
        rsvpStatus: "going",
      },
      "radar"
    );
    await setStatus(userId, id, "saved");
    return { ok: true, kind: "event", message: "Saved to Events", href: `/events/${event.id}` };
  }
  if (row.kind === "person") {
    const p = parsePersonTitle(row.title);
    const url = row.url ?? undefined;
    const out = await resolveOrCreateContact(
      userId,
      {
        fullName: p.fullName,
        title: p.title ?? undefined,
        company: p.company ?? undefined,
        ...(url && isLinkedInProfileUrl(url) ? { linkedinUrl: url } : { website: url }),
        notes: row.why ?? undefined,
        source: "radar",
      },
      { skipRevalidate: true }
    );
    await setStatus(userId, id, "saved");
    return { ok: true, kind: "person", message: `${p.fullName} is in your orbit`, href: `/contacts/${out.contactId}`, contactId: out.contactId };
  }
  if (row.kind === "program") {
    const deadline = row.expiresAt;
    const remindAt = deadline ? new Date(Math.max(deadline.getTime() - PROGRAM_REMIND_DAYS * DAY_MS, now.getTime() + DAY_MS)) : new Date(now.getTime() + DAY_MS);
    await createReminderForUser(
      userId,
      {
        title: `Apply: ${row.title}`,
        description: [row.why, row.url].filter(Boolean).join("\n"),
        dueDate: remindAt.toISOString(),
        actionKind: "task",
      },
      { origin: "suggestion" }
    );
    await setStatus(userId, id, "saved");
    return { ok: true, kind: "program", message: "Reminder set", href: "/reminders" };
  }
  // Openings are job_posting cards on the recommendation side; no writer stores them here yet.
  await setStatus(userId, id, "saved");
  return { ok: true, kind: row.kind, message: "Saved", href: "/radar" };
}

/** Not interested. The reason is kept on the row for the next pass and for metrics. */
export async function dismissOpportunityForUser(userId: string, id: string, reason: RadarDismissReason | null): Promise<{ ok: boolean }> {
  const row = await ownedOpen(userId, id);
  if (!row) return { ok: false };
  await setStatus(userId, id, "dismissed", reason);
  return { ok: true };
}
