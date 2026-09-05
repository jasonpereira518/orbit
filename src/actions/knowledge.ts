"use server";

import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  contactEmbeddings,
  contacts,
  interactions,
} from "@/db/schema";
import { requireUserForSurface } from "@/lib/plan-guards";
import { normalizeInteractionType } from "@/lib/interaction-types";

export type KnowledgeKind =
  | "message"
  | "note"
  | "summary"
  | "key_fact"
  | "meeting";

export type KnowledgeEntry = {
  id: string;
  kind: KnowledgeKind;
  contactId: string;
  contactName: string;
  company: string | null;
  title: string | null;
  snippet: string;
  date: string | null;
  source: string | null;
};

export type KnowledgeStats = {
  people: number;
  messages: number;
  notes: number;
  meetings: number;
  withSummary: number;
  withKeyFacts: number;
  embeddings: number;
};

export type KnowledgeBasePayload = {
  stats: KnowledgeStats;
  entries: KnowledgeEntry[];
};

function iso(d: Date | null | undefined) {
  return d ? new Date(d).toISOString() : null;
}

export async function getKnowledgeBase(): Promise<KnowledgeBasePayload> {
  const userId = await requireUserForSurface("page.knowledge");
  const db = await getDb();

  const [allContacts, allInteractions, embeddingCountRow] = await Promise.all([
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      orderBy: [desc(contacts.updatedAt)],
    }),
    db.query.interactions.findMany({
      where: eq(interactions.userId, userId),
      orderBy: [desc(interactions.interactionDate)],
      limit: 500,
    }),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(contactEmbeddings)
      .where(eq(contactEmbeddings.userId, userId)),
  ]);

  const contactById = new Map(allContacts.map((c) => [c.id, c]));

  // Bucketed through the canonical vocabulary so the legacy values still in the table
  // (`meeting_note`, `outreach`, `coffee`) land with their modern equivalents instead of
  // splitting the same kind of interaction across two counts.
  const kindOf = (type: string | null, rawNotes: string | null): KnowledgeKind => {
    if (!type && rawNotes) return "note";
    const canonical = normalizeInteractionType(type);
    if (canonical === "linkedin_message" || canonical === "message") return "message";
    if (canonical === "meeting" || canonical === "in_person" || canonical === "event") {
      return "meeting";
    }
    return "note";
  };

  const messages = allInteractions.filter(
    (i) => kindOf(i.interactionType, i.rawNotes) === "message"
  );
  const notes = allInteractions.filter(
    (i) => kindOf(i.interactionType, i.rawNotes) === "note"
  );
  const meetings = allInteractions.filter(
    (i) => kindOf(i.interactionType, i.rawNotes) === "meeting"
  );

  const withSummary = allContacts.filter((c) => c.aiSummary?.trim()).length;
  const withKeyFacts = allContacts.filter(
    (c) => (c.keyFacts || []).length > 0
  ).length;

  const stats: KnowledgeStats = {
    people: allContacts.length,
    messages: messages.length,
    notes:
      notes.length +
      allContacts.filter((c) => c.notes?.trim()).length,
    meetings: meetings.length,
    withSummary,
    withKeyFacts,
    embeddings: Number(embeddingCountRow[0]?.count ?? 0),
  };

  const entries: KnowledgeEntry[] = [];

  for (const i of allInteractions.slice(0, 300)) {
    const contact = contactById.get(i.contactId);
    if (!contact) continue;
    const snippet = (i.aiSummary || i.rawNotes || "").trim();
    if (!snippet) continue;

    const kind: KnowledgeKind = kindOf(i.interactionType, i.rawNotes);

    entries.push({
      id: `interaction:${i.id}`,
      kind,
      contactId: contact.id,
      contactName: contact.preferredName || contact.fullName,
      company: contact.company,
      title: contact.title,
      snippet: snippet.slice(0, 420),
      date: iso(i.interactionDate),
      source: i.source,
    });
  }

  for (const c of allContacts) {
    if (c.aiSummary?.trim()) {
      entries.push({
        id: `summary:${c.id}`,
        kind: "summary",
        contactId: c.id,
        contactName: c.preferredName || c.fullName,
        company: c.company,
        title: c.title,
        snippet: c.aiSummary.trim().slice(0, 420),
        date: iso(c.updatedAt),
        source: c.source,
      });
    }
    if (c.notes?.trim()) {
      entries.push({
        id: `notes:${c.id}`,
        kind: "note",
        contactId: c.id,
        contactName: c.preferredName || c.fullName,
        company: c.company,
        title: c.title,
        snippet: c.notes.trim().slice(0, 420),
        date: iso(c.updatedAt),
        source: "profile_notes",
      });
    }
    for (const fact of c.keyFacts || []) {
      if (!fact.trim()) continue;
      entries.push({
        id: `fact:${c.id}:${fact.slice(0, 40)}`,
        kind: "key_fact",
        contactId: c.id,
        contactName: c.preferredName || c.fullName,
        company: c.company,
        title: c.title,
        snippet: fact.trim().slice(0, 420),
        date: iso(c.updatedAt),
        source: "key_facts",
      });
    }
  }

  entries.sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db_ = b.date ? new Date(b.date).getTime() : 0;
    return db_ - da;
  });

  return {
    stats,
    entries: entries.slice(0, 400),
  };
}
