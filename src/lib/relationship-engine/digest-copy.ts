/**
 * The profile digest's shape and copy. No database import: client components render from it.
 */
import { format } from "date-fns";
import type { RelationshipOpenThread, RelationshipTopic } from "@/db/schema";

/** canRemind = the digest has a run that is not undone (a reminder joins that run's batch and is undone with it). */
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

// Date-only values parse at local noon so the zone can't shift the day. Full timestamps format in
// UTC so the server render (UTC) and the browser agree on the day (no hydration mismatch).
const utcDay = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const day = (iso: string) =>
  iso.length === 10 ? format(new Date(`${iso}T12:00:00`), "MMM d") : utcDay.format(new Date(iso));

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

/**
 * The brief's standing line. With none, the empty-brief prompt shows only when no digest is
 * rendered either: under a populated digest it would contradict what is on screen.
 */
export function briefStandingLine(standing: string | null, digest: DigestView | null | undefined): string | null {
  if (standing) return standing;
  return digest ? null : "Log an interaction below and the brief will write itself from your notes.";
}
