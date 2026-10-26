import { FOLLOW_UP_AFTER_DAYS } from "@/lib/outreach-types";

/**
 * Is a follow-up due on this first message? Pure, and imports nothing but `outreach-types`:
 * client components reach it through `outreach-metrics`, so it must never pull in the database.
 *
 * True only for a first message (`stepIndex 0`) that was sent at least `FOLLOW_UP_AFTER_DAYS`
 * ago, has no outcome yet (a reply, a bounce and an unsubscribe all end it), and whose person
 * has no step-1 message in any status (`hasFollowUp`): one follow-up per person, ever.
 */
export function followUpDue(
  first: { stepIndex: number; status: string; sentAt: Date | null; outcome: string | null },
  hasFollowUp: boolean,
  now: Date
): boolean {
  if (hasFollowUp || first.stepIndex !== 0 || first.status !== "sent" || first.outcome != null || !first.sentAt) {
    return false;
  }
  return now.getTime() - first.sentAt.getTime() >= FOLLOW_UP_AFTER_DAYS * 86_400_000;
}
