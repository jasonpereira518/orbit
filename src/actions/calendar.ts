"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { calendarSubscriptions } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import {
  syncCalendarSubscription,
  syncDueCalendarSubscriptions,
} from "@/lib/calendar-sync";

function normalizeIcsUrl(raw: string) {
  let url = raw.trim();
  if (!url) throw new Error("ICS URL is required");

  // Apple / Outlook often copy webcal:// links
  if (url.startsWith("webcal://")) {
    url = `https://${url.slice("webcal://".length)}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Enter a valid calendar URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Calendar URL must start with https://");
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;
  if (
    host.includes("google.com") &&
    /\/calendar\/ical\//i.test(path) &&
    /\/public\/basic\.ics$/i.test(path)
  ) {
    throw new Error(
      "That Google Calendar link is the public address. Use the Secret address in iCal format instead (Calendar settings → Integrate calendar → Secret address in iCal format). It looks like …/private-…/basic.ics."
    );
  }

  return parsed.toString();
}

export async function listCalendarSubscriptions() {
  const userId = await requireUserId();
  const db = await getDb();
  return db.query.calendarSubscriptions.findMany({
    where: eq(calendarSubscriptions.userId, userId),
    orderBy: (s, { desc }) => [desc(s.createdAt)],
  });
}

export async function addCalendarSubscription(input: {
  icsUrl: string;
  label?: string;
  selfEmail?: string;
}) {
  const userId = await requireUserId();
  const db = await getDb();
  const icsUrl = normalizeIcsUrl(input.icsUrl);

  const [row] = await db
    .insert(calendarSubscriptions)
    .values({
      userId,
      icsUrl,
      label: input.label?.trim() || "Calendar",
      selfEmail: input.selfEmail?.trim().toLowerCase() || null,
      enabled: 1,
    })
    .returning();

  // First sync immediately so the user sees results
  let syncError: string | null = null;
  let stats = null;
  try {
    stats = await syncCalendarSubscription(userId, row.id);
  } catch (err) {
    syncError = err instanceof Error ? err.message : "Initial sync failed";
  }

  const subscription =
    (await db.query.calendarSubscriptions.findFirst({
      where: eq(calendarSubscriptions.id, row.id),
    })) || row;

  revalidatePath("/imports");
  revalidatePath("/");
  revalidatePath("/contacts");

  return { subscription, stats, syncError };
}

export async function updateCalendarSubscription(
  id: string,
  input: {
    label?: string;
    icsUrl?: string;
    selfEmail?: string | null;
    enabled?: boolean;
  }
) {
  const userId = await requireUserId();
  const db = await getDb();

  const [row] = await db
    .update(calendarSubscriptions)
    .set({
      ...(input.label !== undefined ? { label: input.label.trim() || "Calendar" } : {}),
      ...(input.icsUrl !== undefined
        ? { icsUrl: normalizeIcsUrl(input.icsUrl) }
        : {}),
      ...(input.selfEmail !== undefined
        ? { selfEmail: input.selfEmail?.trim().toLowerCase() || null }
        : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled ? 1 : 0 } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(calendarSubscriptions.id, id),
        eq(calendarSubscriptions.userId, userId)
      )
    )
    .returning();

  revalidatePath("/imports");
  return row;
}

export async function removeCalendarSubscription(id: string) {
  const userId = await requireUserId();
  const db = await getDb();
  await db
    .delete(calendarSubscriptions)
    .where(
      and(
        eq(calendarSubscriptions.id, id),
        eq(calendarSubscriptions.userId, userId)
      )
    );
  revalidatePath("/imports");
}

export async function syncCalendarSubscriptionNow(id: string) {
  const userId = await requireUserId();
  const stats = await syncCalendarSubscription(userId, id);
  revalidatePath("/imports");
  revalidatePath("/");
  revalidatePath("/contacts");
  return stats;
}

export async function syncStaleCalendarSubscriptions() {
  const userId = await requireUserId();
  const results = await syncDueCalendarSubscriptions(userId);
  if (results.length) {
    revalidatePath("/imports");
    revalidatePath("/");
    revalidatePath("/contacts");
  }
  return results;
}
