import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  actionItems,
  contactBriefs,
  contactIdentities,
  contacts,
  interactions,
  reminders,
  type NewContact,
} from "@/db/schema";
import { actionItemHash } from "@/lib/action-items";
import { markCohortDirty } from "@/lib/closeness-materialize";
import { createCompanyResolver } from "@/lib/companies";
import { buildRecentDiscussions } from "@/lib/contact-brief";
import { identityKeysFor } from "@/lib/duplicates";
import { getInboxListId } from "@/lib/reminder-lists";
import { EXAMPLE_PEOPLE, type ExamplePerson } from "@/lib/onboarding-examples/cast";
import { TOUR_EXAMPLE_SOURCE } from "@/lib/onboarding-examples/marker";

const DAY = 24 * 60 * 60 * 1000;

function summaryFor(p: ExamplePerson) {
  const role = p.company ? `${p.title} at ${p.company}` : p.school ? `${p.title} at ${p.school}` : p.title;
  return `${p.fullName} is ${role}. How you met: ${p.howMet}. ${p.notes}`.trim();
}

/**
 * Plants the tour's example people for one account. Raw inserts, like the demo seeder, on
 * purpose: the real contact write path counts against the plan's headroom, schedules
 * embeddings and brief generation (both AI), and revalidates per row — none of which six
 * rows that vanish at the end of the tour should trigger.
 *
 * Idempotent: an account that already has an example person gets nothing new, so the
 * handoff can be retried and a strict-mode double mount costs one no-op query.
 *
 * Not a transaction (neon-http has none). A failure part-way leaves marked rows behind,
 * which `removeTourExamples` clears the same way it clears a finished set.
 */
export async function seedTourExamples(userId: string): Promise<{ seeded: number }> {
  const db = await getDb();
  const existing = await db.query.contacts.findFirst({
    where: and(eq(contacts.userId, userId), eq(contacts.source, TOUR_EXAMPLE_SOURCE)),
    columns: { id: true },
  });
  if (existing) return { seeded: 0 };

  const now = Date.now();
  const ago = (days: number) => new Date(now - days * DAY);
  const at = (days: number) => new Date(now + days * DAY);

  const resolver = await createCompanyResolver(userId);
  await resolver.prime(EXAMPLE_PEOPLE.map((p) => p.company));

  const ids = new Map(EXAMPLE_PEOPLE.map((p) => [p.key, randomUUID()]));
  const rows: NewContact[] = [];
  for (const p of EXAMPLE_PEOPLE) {
    const days = p.touches.map((t) => t.at);
    const company = p.company ? await resolver(p.company) : null;
    rows.push({
      id: ids.get(p.key)!,
      userId,
      fullName: p.fullName,
      firstName: p.firstName,
      lastName: p.lastName,
      title: p.title,
      company: p.company,
      companyId: company?.id ?? null,
      school: p.school,
      location: p.location,
      email: p.email,
      linkedinUrl: `https://www.linkedin.com/in/${p.linkedinSlug}`,
      relationshipScore: p.closeness,
      statedCloseness: p.closeness,
      source: TOUR_EXAMPLE_SOURCE,
      howMet: p.howMet,
      metContext: p.metContext,
      dateMet: ago(p.metDaysAgo),
      notes: p.notes,
      keyFacts: p.keyFacts,
      aiSummary: summaryFor(p),
      firstInteractionAt: ago(Math.max(...days)),
      lastInteractionAt: ago(Math.min(...days)),
      nextFollowUpAt: p.followUpInDays == null ? null : at(p.followUpInDays),
      followUpStatus: p.followUpInDays == null ? "none" : "pending",
      // Deliberately NOT flagged for the embedding backfill: these rows are gone in minutes,
      // and chat's keyword arm already finds them by name, company, notes and summary.
      embeddingStaleAt: null,
      // Nor for the photo backfill: fictional people have no photo to find, and a lookup
      // would spend third-party quota (the avatar route refuses them too).
      profileImageCheckedAt: new Date(),
    });
  }
  await db.insert(contacts).values(rows);

  const identityRows = EXAMPLE_PEOPLE.flatMap((p) =>
    identityKeysFor({
      email: p.email,
      linkedinUrl: `https://www.linkedin.com/in/${p.linkedinSlug}`,
    }).map((k) => ({
      userId,
      contactId: ids.get(p.key)!,
      kind: k.kind,
      value: k.value,
      source: TOUR_EXAMPLE_SOURCE,
    })),
  );
  if (identityRows.length) {
    await db.insert(contactIdentities).values(identityRows).onConflictDoNothing();
  }

  // Timelines. Ids are minted here so action items and briefs can point at their
  // interaction without relying on RETURNING order.
  const interactionRows: (typeof interactions.$inferInsert)[] = [];
  const itemRows: (typeof actionItems.$inferInsert)[] = [];
  const briefRows: (typeof contactBriefs.$inferInsert)[] = [];
  for (const p of EXAMPLE_PEOPLE) {
    const contactId = ids.get(p.key)!;
    const mine: {
      id: string;
      interactionDate: Date;
      interactionType: string;
      aiSummary: null;
      rawNotes: string;
    }[] = [];
    for (const t of p.touches) {
      const id = randomUUID();
      const interactionDate = ago(t.at);
      interactionRows.push({
        id,
        userId,
        contactId,
        interactionType: t.type,
        interactionDate,
        source: TOUR_EXAMPLE_SOURCE,
        rawNotes: t.notes,
        topics: t.topics ?? [],
        actionItems: t.actionItems ?? [],
      });
      mine.push({ id, interactionDate, interactionType: t.type, aiSummary: null, rawNotes: t.notes });
      (t.actionItems ?? []).forEach((text, position) => {
        itemRows.push({
          userId,
          contactId,
          interactionId: id,
          text,
          position,
          itemHash: actionItemHash(id, text),
        });
      });
    }
    const recent = buildRecentDiscussions(mine);
    briefRows.push({
      contactId,
      userId,
      standing: p.standing,
      recentDiscussions: recent,
      basisInteractionId: recent[0]?.interactionId ?? null,
      // A static brief. `inputHash` stays null, so a later real regeneration (which only
      // happens with AI available) replaces it rather than trusting it.
      model: TOUR_EXAMPLE_SOURCE,
    });
  }
  if (interactionRows.length) await db.insert(interactions).values(interactionRows);
  if (itemRows.length) await db.insert(actionItems).values(itemRows);
  if (briefRows.length) await db.insert(contactBriefs).values(briefRows);

  // Every reminder carries a contactId: that is what lets removal be a cascade.
  const inboxId = await getInboxListId(userId);
  const reminderRows: (typeof reminders.$inferInsert)[] = EXAMPLE_PEOPLE.flatMap((p) =>
    p.reminder
      ? [
          {
            userId,
            contactId: ids.get(p.key)!,
            listId: inboxId,
            title: p.reminder.title,
            description: p.reminder.description,
            dueDate: at(p.reminder.inDays),
            actionKind: "follow_up" as const,
          },
        ]
      : [],
  );
  if (reminderRows.length) await db.insert(reminders).values(reminderRows);

  await markCohortDirty(userId).catch(() => null);
  return { seeded: rows.length };
}
