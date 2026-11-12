/**
 * Who sent their details back through the owner's card, and the owner's quick note on one.
 *
 * Everything on a `card_shares` row except `ownerNote` was typed by a stranger. The note is
 * the owner's own text, so it is the only thing here that reaches the contact's timeline.
 */
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { cardShares, contacts, events, interactions, type CardShareStatus } from "@/db/schema";
import { resolveArrival } from "@/lib/cards/share-back";
import { logNoteInteractionForUser, scheduleEmbeddingRebuild, type ContactWriteOptions } from "@/lib/contact-writes";

export type Arrival = {
  id: string;
  name: string;
  company: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  message: string | null;
  status: CardShareStatus;
  contactId: string | null;
  /** The owner's contact this arrival points at, for labelling a match. */
  contactName: string | null;
  eventTitle: string | null;
  ownerNote: string | null;
  createdAt: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listArrivals(userId: string, limit = 50): Promise<Arrival[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: cardShares.id,
      name: cardShares.name,
      company: cardShares.company,
      title: cardShares.title,
      email: cardShares.email,
      phone: cardShares.phone,
      message: cardShares.message,
      status: cardShares.status,
      contactId: cardShares.contactId,
      contactName: contacts.fullName,
      eventTitle: events.title,
      ownerNote: cardShares.ownerNote,
      createdAt: cardShares.createdAt,
    })
    .from(cardShares)
    .leftJoin(contacts, and(eq(contacts.id, cardShares.contactId), eq(contacts.userId, userId)))
    .leftJoin(events, and(eq(events.id, cardShares.eventId), eq(events.userId, userId)))
    .where(eq(cardShares.userId, userId))
    .orderBy(desc(cardShares.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

export async function addArrivalNoteCore(
  userId: string,
  shareId: string,
  text: string,
  options: ContactWriteOptions = { skipRevalidate: true }
): Promise<{ ok: true } | { ok: false; message: string }> {
  const note = text.trim().slice(0, 2000);
  if (!note) return { ok: false, message: "Write a note first" };
  if (!UUID_RE.test(shareId)) return { ok: false, message: "That arrival isn’t there anymore" };
  const db = await getDb();
  const [share] = await db
    .select({ status: cardShares.status, contactId: cardShares.contactId })
    .from(cardShares)
    .where(and(eq(cardShares.id, shareId), eq(cardShares.userId, userId)))
    .limit(1);
  if (!share) return { ok: false, message: "That arrival isn’t there anymore" };
  if (share.status === "held") return { ok: false, message: "Make room in your contacts first." };
  if (!share.contactId) return { ok: false, message: "That person isn’t in your contacts anymore" };

  // Keyed by the share, so the timeline holds one note per arrival; a later save edits it.
  const externalId = `card-note:${shareId}`;
  const { created } = await logNoteInteractionForUser(
    userId,
    { contactId: share.contactId, rawNotes: note, interactionType: "note", source: "card", externalId },
    options
  );
  if (!created) {
    await db
      .update(interactions)
      .set({ rawNotes: note })
      .where(and(eq(interactions.userId, userId), eq(interactions.externalId, externalId)));
    if (!options.skipEmbedding) await scheduleEmbeddingRebuild(userId, share.contactId);
  }
  await db.update(cardShares).set({ ownerNote: note }).where(and(eq(cardShares.id, shareId), eq(cardShares.userId, userId)));
  return { ok: true };
}

/**
 * The owner's "Add to contacts" on a held arrival: the same untrusted resolve and fixed
 * timeline line the share-back runs, now that there may be room.
 */
export async function addHeldArrivalCore(userId: string, shareId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!UUID_RE.test(shareId)) return { ok: false, message: "That arrival isn’t there anymore" };
  const db = await getDb();
  const [share] = await db
    .select()
    .from(cardShares)
    .where(and(eq(cardShares.id, shareId), eq(cardShares.userId, userId)))
    .limit(1);
  if (!share) return { ok: false, message: "That arrival isn’t there anymore" };
  if (share.status !== "held") return { ok: true };

  const [event] = share.eventId
    ? await db
        .select({ id: events.id, title: events.title })
        .from(events)
        .where(and(eq(events.id, share.eventId), eq(events.userId, userId)))
        .limit(1)
    : [];
  const status = await resolveArrival(
    userId,
    share.id,
    {
      fullName: share.name,
      email: share.email ?? undefined,
      phone: share.phone ?? undefined,
      company: share.company ?? undefined,
      title: share.title ?? undefined,
      linkedinUrl: share.linkedinUrl ?? undefined,
    },
    event ?? null
  );
  if (status === "held") return { ok: false, message: "You're at your contact limit." };
  return { ok: true };
}
