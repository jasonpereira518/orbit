/**
 * Where a reminder should link to when clicked, shared by the notification panel and
 * every reminder-card renderer so the destination can't drift between them.
 *
 * Pure — no `next/server` import — because `scheduleLinkedInExportReminder` and friends
 * live in a "use server" action module, but this also needs to stay importable from plain
 * tsx scripts and client components.
 */
export function reminderHref(r: {
  reminderType?: string | null;
  contactId?: string | null;
}): string {
  if (r.reminderType === "linkedin_export") return "/imports";
  if (r.contactId) return `/contacts/${r.contactId}`;
  return "/reminders";
}
