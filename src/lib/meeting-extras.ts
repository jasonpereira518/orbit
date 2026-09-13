/**
 * The digest items a meeting offers as extra reminders, keyed stably so the summary's
 * ticks survive a reload and the runner can rebuild the same list from the stored digest.
 * Pure — shared by the client summary and the job runner.
 */
import type { MeetingDigest } from "@/db/schema";
import type { CaptureMeetingExtra } from "@/lib/capture/types";

export function meetingExtrasFromDigest(digest: MeetingDigest): CaptureMeetingExtra[] {
  return [
    ...digest.actionItems.map((a, i) => ({
      key: `action:${i}`,
      kind: "action" as const,
      title: a.text,
      ownerName: a.owner && a.owner !== "me" ? a.owner : null,
      sourceExcerpt: a.sourceExcerpt,
      // Your own commitments are the ones you most want reminding of. Other people's are
      // theirs to track; they start unticked but one click away.
      checkedByDefault: a.owner === "me",
    })),
    ...digest.blockers.map((b, i) => ({
      key: `blocker:${i}`,
      kind: "blocker" as const,
      title: b.text,
      ownerName: b.owner && b.owner !== "me" ? b.owner : null,
      sourceExcerpt: b.sourceExcerpt,
      checkedByDefault: false,
    })),
    ...digest.openQuestions.map((q, i) => ({
      key: `question:${i}`,
      kind: "question" as const,
      title: q.text,
      ownerName: q.askedBy && q.askedBy !== "me" ? q.askedBy : null,
      sourceExcerpt: q.sourceExcerpt,
      checkedByDefault: false,
    })),
  ];
}
