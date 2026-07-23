import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { reminderLists } from "@/db/schema";

export const INBOX_LIST_NAME = "Inbox";

function normalizeListName(raw: string) {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

function displayListName(raw: string) {
  return raw.trim().replace(/\s+/g, " ");
}

/** Ensure the user has an Inbox list; return all lists ordered by position. */
export async function ensureReminderLists(userId: string) {
  const db = await getDb();
  let lists = await db.query.reminderLists.findMany({
    where: eq(reminderLists.userId, userId),
    orderBy: [asc(reminderLists.position), asc(reminderLists.createdAt)],
  });

  const inbox = lists.find((l) => l.isInbox === 1);
  if (!inbox) {
    try {
      const [created] = await db
        .insert(reminderLists)
        .values({
          userId,
          name: INBOX_LIST_NAME,
          nameNormalized: normalizeListName(INBOX_LIST_NAME),
          position: 0,
          isInbox: 1,
        })
        .returning();
      if (created) {
        lists = [created, ...lists];
      }
    } catch {
      lists = await db.query.reminderLists.findMany({
        where: eq(reminderLists.userId, userId),
        orderBy: [asc(reminderLists.position), asc(reminderLists.createdAt)],
      });
    }
  }

  return [...lists].sort((a, b) => {
    if (a.isInbox !== b.isInbox) return b.isInbox - a.isInbox;
    if (a.position !== b.position) return a.position - b.position;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

export async function getInboxListId(userId: string) {
  const lists = await ensureReminderLists(userId);
  const inbox = lists.find((l) => l.isInbox === 1) ?? lists[0];
  if (!inbox) throw new Error("Could not create Inbox list");
  return inbox.id;
}

export async function findReminderListForUser(userId: string, listId: string) {
  const db = await getDb();
  return db.query.reminderLists.findFirst({
    where: and(eq(reminderLists.id, listId), eq(reminderLists.userId, userId)),
  });
}

export { normalizeListName, displayListName };
