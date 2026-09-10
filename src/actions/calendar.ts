"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db";
import { calendarSubscriptions } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { requireSyncUser } from "@/lib/plan-guards";
import {
  syncCalendarSubscription,
  syncDueCalendarSubscriptions,
} from "@/lib/calendar-sync";
import { asActionResult, friendlyError, UserFacingError } from "@/lib/errors";

function normalizeIcsUrl(raw: string) {
  let url = raw.trim();
  if (!url) throw new UserFacingError("Paste the calendar’s ICS link first");

  // Apple / Outlook often copy webcal:// links
  if (url.startsWith("webcal://")) {
    url = `https://${url.slice("webcal://".length)}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UserFacingError("That doesn’t look like a calendar link — check it and try again");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new UserFacingError("Calendar links need to start with https://");
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;
  if (
    host.includes("google.com") &&
    /\/calendar\/ical\//i.test(path) &&
    /\/public\/basic\.ics$/i.test(path)
  ) {
    // The most useful message in this flow, and the one production used to hide: it
    // arrived as a digest, so the person never learned which link to paste instead.
    throw new UserFacingError(
      "That’s your calendar’s public address — use the Secret address in iCal format instead (Calendar settings → Integrate calendar). It looks like …/private-…/basic.ics"
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
  return asActionResult(async () => {
    const userId = await requireSyncUser();
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
      // Returned as data, so never stripped — and a sync failure can carry a provider's
      // raw response body (`Google Calendar 403: {…}`). Sanitise it here.
      syncError = friendlyError(err, "the first sync didn’t finish");
    }

    const subscription =
      (await db.query.calendarSubscriptions.findFirst({
        where: eq(calendarSubscriptions.id, row.id),
      })) || row;

    revalidatePath("/imports");
    revalidatePath("/");
    revalidatePath("/contacts");

    return { subscription, stats, syncError };
  });
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
  const userId = await requireSyncUser();
  const stats = await syncCalendarSubscription(userId, id);
  revalidatePath("/imports");
  revalidatePath("/");
  revalidatePath("/contacts");
  return stats;
}

export async function syncStaleCalendarSubscriptions() {
  const userId = await requireSyncUser();
  const results = await syncDueCalendarSubscriptions(userId);
  if (results.length) {
    revalidatePath("/imports");
    revalidatePath("/");
    revalidatePath("/contacts");
  }
  return results;
}
