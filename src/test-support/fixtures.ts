/**
 * A small, hand-authored network for the golden tests. Every id is a fixed uuid and every
 * timestamp is an offset from `FROZEN_NOW`, so two runs seed byte-identical rows (including
 * the `ORDER BY ... id` tiebreaks the dashboard queries use).
 *
 * Import `scripts/smoke/_env` before this module.
 */
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contactTags, contacts, interactions, reminders, tags, userGoals } from "@/db/schema";
import { ensureUserSettings } from "@/lib/user-settings";
import { daysAgo, daysAhead } from "./golden";

/** Deterministic uuid: `fixedId(1)` -> 00000000-0000-4000-8000-000000000001. */
export const fixedId = (n: number, ns = 0) =>
  `0000000${ns}-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const GOLDEN_USER = "golden-user";

export type FixtureContact = {
  n: number;
  fullName: string;
  company?: string | null;
  school?: string | null;
  title?: string | null;
  email?: string | null;
  notes?: string | null;
  orbitScore?: number | null;
  relationshipScore?: number;
  lastInteractionDays?: number | null;
  followUpDays?: number | null; // negative = overdue
  priorityLevel?: number;
  tagNames?: string[];
};

export const NETWORK: FixtureContact[] = [
  { n: 1, fullName: "Ada Lovelace", company: "Acme", school: "MIT", title: "Engineer", email: "ada@acme.test", notes: "Met at the Acme summit.", relationshipScore: 4, lastInteractionDays: 3, followUpDays: -2, priorityLevel: 2, tagNames: ["mentor"] },
  { n: 2, fullName: "Grace Hopper", company: "Acme", school: "Yale", title: "Founder", email: "grace@acme.test", relationshipScore: 5, lastInteractionDays: 10, followUpDays: -10, priorityLevel: 1, tagNames: ["mentor", "founder"] },
  { n: 3, fullName: "Alan Turing", company: "Bletchley", school: "MIT", title: "Researcher", relationshipScore: 3, lastInteractionDays: 40, followUpDays: 5 },
  { n: 4, fullName: "Katherine Johnson", company: "Bletchley", school: "MIT", title: "Analyst", relationshipScore: 2, lastInteractionDays: 400, followUpDays: null },
  { n: 5, fullName: "Margaret Hamilton", company: "Zenith", school: null, title: "Director", relationshipScore: 4, lastInteractionDays: 1, followUpDays: -1, notes: "Wants an intro to a hardware lead." },
  { n: 6, fullName: "Linus Torvalds", company: "Zenith", school: "Helsinki", title: "Maintainer", relationshipScore: 2, lastInteractionDays: null, followUpDays: null },
  { n: 7, fullName: "Barbara Liskov", company: "Zenith", school: "MIT", title: "Professor", relationshipScore: 3, lastInteractionDays: 20, followUpDays: 30 },
  { n: 8, fullName: "Dennis Ritchie", company: "Acme", school: "Harvard", title: "Staff", relationshipScore: 3, lastInteractionDays: 7, followUpDays: -4 },
  { n: 9, fullName: "Radia Perlman", company: null, school: null, title: null, relationshipScore: 1, lastInteractionDays: null, followUpDays: null },
  { n: 10, fullName: "Ken Thompson", company: "Bletchley", school: null, title: "Engineer", relationshipScore: 2, lastInteractionDays: 90, followUpDays: -20 },
];

/** Wipes and seeds `GOLDEN_USER` with `NETWORK`, a few interactions, reminders, tags and a goal. */
export async function seedNetwork(userId = GOLDEN_USER, network: FixtureContact[] = NETWORK) {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, userId));
  await db.delete(tags).where(eq(tags.userId, userId));
  await db.delete(userGoals).where(eq(userGoals.userId, userId));
  await ensureUserSettings(userId);

  await db.insert(contacts).values(
    network.map((c) => ({
      id: fixedId(c.n),
      userId,
      fullName: c.fullName,
      company: c.company ?? null,
      school: c.school ?? null,
      title: c.title ?? null,
      email: c.email ?? null,
      notes: c.notes ?? null,
      relationshipScore: c.relationshipScore ?? 2,
      orbitScore: c.orbitScore ?? null,
      priorityLevel: c.priorityLevel ?? 0,
      lastInteractionAt: c.lastInteractionDays == null ? null : daysAgo(c.lastInteractionDays),
      nextFollowUpAt: c.followUpDays == null ? null : daysAhead(c.followUpDays),
      createdAt: daysAgo(200 - c.n),
      updatedAt: daysAgo(100 - c.n),
    }))
  );

  const tagNames = [...new Set(network.flatMap((c) => c.tagNames ?? []))].sort();
  if (tagNames.length) {
    await db.insert(tags).values(tagNames.map((name, i) => ({ id: fixedId(i + 1, 1), userId, name, createdAt: daysAgo(150) })));
    const links = network.flatMap((c) =>
      (c.tagNames ?? []).map((t) => ({ contactId: fixedId(c.n), tagId: fixedId(tagNames.indexOf(t) + 1, 1) }))
    );
    if (links.length) await db.insert(contactTags).values(links);
  }

  const withInteraction = network.filter((c) => c.lastInteractionDays != null);
  if (withInteraction.length) {
    await db.insert(interactions).values(
      withInteraction.map((c) => ({
        id: fixedId(c.n, 2),
        userId,
        contactId: fixedId(c.n),
        interactionType: c.n % 2 ? "linkedin_message" : "meeting",
        interactionDate: daysAgo(c.lastInteractionDays!),
        rawNotes: `Talked with ${c.fullName} about ${c.company ?? "their work"}.`,
        createdAt: daysAgo(c.lastInteractionDays!),
      }))
    );
  }

  await db.insert(reminders).values([
    { id: fixedId(1, 3), userId, contactId: fixedId(1), title: "Send Ada the deck", dueDate: daysAgo(1), status: "pending", createdAt: daysAgo(5) },
    { id: fixedId(2, 3), userId, contactId: fixedId(5), title: "Intro Margaret to hardware lead", dueDate: daysAhead(2), status: "pending", createdAt: daysAgo(4) },
    { id: fixedId(3, 3), userId, contactId: fixedId(3), title: "Old done thing", dueDate: daysAgo(9), status: "completed", createdAt: daysAgo(12) },
    { id: fixedId(4, 3), userId, contactId: null, title: "File expenses", dueDate: daysAhead(20), status: "pending", createdAt: daysAgo(3) },
  ]);

  await db.insert(userGoals).values({ id: fixedId(1, 4), userId, text: "Meet more people in hardware", active: 1, createdAt: daysAgo(30) });
}
