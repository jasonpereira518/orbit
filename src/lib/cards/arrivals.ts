/**
 * Who sent their details back through the owner's card, and the owner's quick note on one.
 *
 * Everything on a `card_shares` row except `ownerNote` was typed by a stranger. The note is
 * the owner's own text, so it is the only thing here that reaches the contact's timeline.
 */
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { cardShares, contacts, events, type CardShareStatus } from "@/db/schema";
import { logNoteInteractionForUser, type ContactWriteOptions } from "@/lib/contact-writes";

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

  // Keyed by the share, so only the first save lands on the timeline; later saves edit the
  // note shown on the arrival.
  await logNoteInteractionForUser(
    userId,
    { contactId: share.contactId, rawNotes: note, interactionType: "note", source: "card", externalId: `card-note:${shareId}` },
    options
  );
  await db.update(cardShares).set({ ownerNote: note }).where(and(eq(cardShares.id, shareId), eq(cardShares.userId, userId)));
  return { ok: true };
}
