/**
 * The profile digest's shape and copy. No database import: client components render from it.
 */
import { format } from "date-fns";
import type { RelationshipOpenThread, RelationshipTopic } from "@/db/schema";

/** canRemind = the digest has a run (a reminder can join that run's batch and be undone with it). */
export type DigestThread = RelationshipOpenThread & { canRemind: boolean };
export type DigestView = {
  whatTheyDo: string | null;
  workingOn: string | null;
  summary: string | null;
  topics: RelationshipTopic[]; // max 8, most recently discussed first
  openThreads: DigestThread[];
  messageCount: number;
  sources: string[];
  updatedAt: string | null;
  historyTruncatedBefore: string | null;
};

const SOURCE_LABEL: Record<string, string> = { linkedin: "LinkedIn", whatsapp: "WhatsApp", imessage: "iMessage" };

// Date-only values parse at local noon so the zone can't shift the day.
const day = (iso: string) => format(new Date(iso.length === 10 ? `${iso}T12:00:00` : iso), "MMM d");

export function digestSourceLine(d: Pick<DigestView, "messageCount" | "sources" | "updatedAt">): string | null {
  if (!d.messageCount) return null;
  const labels = d.sources.map((s) => SOURCE_LABEL[s] ?? s);
  const noun = d.messageCount === 1 ? "message" : "messages";
  const from =
    labels.length === 1
      ? `From ${d.messageCount} ${labels[0]} ${noun}`
      : labels.length > 1
        ? `From ${d.messageCount} ${noun} on ${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`
        : `From ${d.messageCount} ${noun}`;
  return d.updatedAt ? `${from} · updated ${day(d.updatedAt)}` : from;
}

export function topicLine(t: RelationshipTopic): string {
  return `${t.label} · last discussed ${day(t.lastDiscussedAt)}`;
}
