import { prospectPipelineBucket, type MessageMetricRow } from "@/lib/outreach-metrics";
import {
  LINKEDIN_NOTE_MAX,
  OUTCOME_LABELS,
  type OutreachChannel,
  type OutreachMessageOutcome,
  type PipelineFilter,
} from "@/lib/outreach-types";

/**
 * What the Messages tab decides from a campaign's people: who can be written to, who has a
 * draft to send, who is waiting on a reply. Pure and client-safe (it imports `outreach-metrics`
 * and nothing that reaches the database), so the tab and its smoke read the same rules.
 *
 * The one rule that matters most: a person who has an outcome (a reply, a bounce, an
 * unsubscribe) on any message is never offered a send, a copy or a follow-up. The server
 * refuses those too, but quietly, so the screen must not invite them.
 */

export type ViewMessage = MessageMetricRow & {
  channel: string;
  subject: string | null;
  body: string;
  errorMessage: string | null;
};

export type ViewPerson = {
  id: string;
  status: string;
  fullName: string;
  title: string | null;
  company: string | null;
  email: string | null;
  linkedinUrl: string | null;
  messages: ViewMessage[];
};

/** A message the user can still rewrite by hand (`generated` is the legacy `draft`). */
export const EDITABLE_STATUSES: readonly string[] = ["draft", "generated"];
/** What the send claim takes: a draft, or a send that definitely failed. */
export const SENDABLE_STATUSES: readonly string[] = ["draft", "generated", "failed"];
/** Statuses that need something from the user: send it, or confirm the LinkedIn paste. */
const ACTIONABLE_STATUSES: readonly string[] = [...SENDABLE_STATUSES, "copied"];
/** Out of the user's hands: sent, being sent, may have been, or legacy delivered. */
const OUT_STATUSES: readonly string[] = ["queued", "sent", "opened", "unsure"];

const stepOf = (m: { stepIndex?: number | null }) => m.stepIndex ?? 0;

export function firstMessage(person: Pick<ViewPerson, "messages">): ViewMessage | undefined {
  return person.messages.find((m) => stepOf(m) === 0);
}

/** The message the person is at: their follow-up when they have one, else the first. */
export function currentMessage(person: Pick<ViewPerson, "messages">): ViewMessage | undefined {
  const followUp = person.messages.filter((m) => stepOf(m) > 0).sort((a, b) => stepOf(b) - stepOf(a))[0];
  return followUp ?? firstMessage(person);
}

/** Any outcome on any message: they answered, bounced or unsubscribed. */
export function hasAnyOutcome(person: Pick<ViewPerson, "messages">) {
  return person.messages.some((m) => Boolean(m.outcome));
}

export type ReadyItem = { person: ViewPerson; message: ViewMessage };

export type SentItem = {
  person: ViewPerson;
  /** Waiting, Follow-up due, Replied, Unsure… */
  label: string;
  tone: "neutral" | "good" | "warn";
  /** The first message's id when a follow-up is due, else null. */
  followUpOf: string | null;
  /** The message the outcome buttons act on: the latest one that went out (status `sent`). */
  outcomeTarget: ViewMessage | null;
  /** When the latest message went out. */
  sentAt: Date | string | null;
  /** The error text of a may-have-sent message. */
  problem: string | null;
};

export type MessageGroups = {
  needsInfo: ViewPerson[];
  needsDraft: ViewPerson[];
  ready: ReadyItem[];
  sent: SentItem[];
};

function sentItem(person: ViewPerson, bucket: PipelineFilter): SentItem {
  const current = currentMessage(person)!;
  const out = person.messages.find((m) => m.outcome);
  const outcomeTarget =
    person.messages.filter((m) => m.status === "sent").sort((a, b) => stepOf(b) - stepOf(a))[0] ?? null;

  let label = "Waiting";
  let tone: SentItem["tone"] = "neutral";
  if (out) {
    label = OUTCOME_LABELS[out.outcome as OutreachMessageOutcome] ?? out.outcome!;
    tone = out.outcome === "bounced" || out.outcome === "unsubscribed" ? "warn" : "good";
  } else if (current.status === "unsure") {
    label = "Unsure";
    tone = "warn";
  } else if (current.status === "queued") {
    label = "Sending";
  } else if (bucket === "follow_up_due") {
    label = "Follow-up due";
  } else if (stepOf(current) > 0) {
    label = "Follow-up sent — waiting";
  }
  return {
    person,
    label,
    tone,
    followUpOf: bucket === "follow_up_due" && !hasAnyOutcome(person) ? (firstMessage(person)?.id ?? null) : null,
    outcomeTarget,
    sentAt: outcomeTarget?.sentAt ?? null,
    problem: current.status === "unsure" ? current.errorMessage : null,
  };
}

/**
 * Sort a campaign's people into what the Messages tab lists. Each person is in at most one
 * list; a removed (`excluded`) person is in none.
 *
 *   needsInfo   no address on the campaign's channel yet (Send would only refuse)
 *   needsDraft  selected, with no first message at all: the only people "Write drafts" takes,
 *               because drafting rewrites any draft it finds and would overwrite hand edits
 *   ready       a draft or follow-up to send, a failed send to try again, or a copied LinkedIn
 *               note waiting for "I sent it"
 *   sent        out the door, being sent, or possibly sent; with a status and, when due, a
 *               follow-up to write
 */
export function messageGroups(
  people: ViewPerson[],
  channel: OutreachChannel,
  now: Date = new Date()
): MessageGroups {
  const groups: MessageGroups = { needsInfo: [], needsDraft: [], ready: [], sent: [] };
  for (const person of people) {
    if (person.status === "excluded") continue;
    const bucket = prospectPipelineBucket(person, channel, now);
    const current = currentMessage(person);

    if (bucket === "needs_info") {
      groups.needsInfo.push(person);
    } else if (bucket === "needs_draft") {
      if (!firstMessage(person) && person.status === "selected") groups.needsDraft.push(person);
    } else if (bucket === "ready") {
      if (current && ACTIONABLE_STATUSES.includes(current.status)) groups.ready.push({ person, message: current });
      else if (current && OUT_STATUSES.includes(current.status)) groups.sent.push(sentItem(person, bucket));
    } else if (bucket === "failed" && current?.status === "failed" && !hasAnyOutcome(person)) {
      groups.ready.push({ person, message: current });
    } else if (current) {
      groups.sent.push(sentItem(person, bucket));
    }
  }
  return groups;
}

/**
 * Why "Copy & open" is not available for this note right now, or null. The server copies the
 * text it has saved and refuses one over the limit, so unsaved edits and a long note both
 * block here. `.length` counts UTF-16 units, exactly as the server does.
 */
export function copyBlockedReason(message: Pick<ViewMessage, "body">, dirty: boolean): string | null {
  if (dirty) return "Save your changes first — the saved note is what gets copied";
  if (message.body.length > LINKEDIN_NOTE_MAX) {
    return `LinkedIn notes are limited to ${LINKEDIN_NOTE_MAX} characters — shorten this one`;
  }
  return null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a send did, in a line for the toast. */
export function sendSummary(result: {
  sent: number;
  pending: number;
  notSent: number;
  failed: unknown[];
}): { text: string; tone: "success" | "warn" } {
  if (!result.sent && !result.pending && !result.failed.length && !result.notSent) {
    return { text: "Nothing new to send — they may already be on their way", tone: "warn" };
  }
  const parts = [`Sent ${result.sent}`];
  if (result.pending) parts.push(`${result.pending} sending`);
  if (result.failed.length) parts.push(`${result.failed.length} needs attention`);
  if (result.notSent) parts.push(notSentLine(result.notSent));
  return { text: parts.join(" · "), tone: result.failed.length || result.notSent ? "warn" : "success" };
}

/** A send stopped before it reached everyone: those messages are drafts again. */
export function notSentLine(count: number) {
  return `${count} not sent yet — send again`;
}

export const draftedLine = (n: number) => `Wrote ${plural(n, "draft")}`;

export type SendLineReason = "not_connected" | "no_send_scope" | "needs_reauth" | "cap_reached";

/** What the Messages tab shows of the user's mailbox: who it sends as and how much is left today. */
export type SendLine =
  | { ok: true; fromEmail: string; remainingToday: number; dailyCap: number }
  | { ok: false; reason: SendLineReason };

/** Narrow a `SendCapability` to the plain fields the client may see (no mailbox list, no tokens). */
export function toSendLine(
  capability:
    | { ok: true; fromEmail: string; remainingToday: number; dailyCap: number }
    | { ok: false; reason: SendLineReason }
): SendLine {
  return capability.ok
    ? {
        ok: true,
        fromEmail: capability.fromEmail,
        remainingToday: capability.remainingToday,
        dailyCap: capability.dailyCap,
      }
    : { ok: false, reason: capability.reason };
}
