/**
 * Which people an email names are worth offering to the user as "Add to Orbit".
 *
 * Pure: it sees the events' rows and says who survives. Everything that needs the database
 * (is this address already a contact, does a contact already have this name, was this person
 * dismissed) is `inbox-people.ts`, which calls this first and filters what is left.
 *
 * ## Who is never offered
 *
 *  - Anyone without an address. The address is the join key: it is what lets the next Radar
 *    run find the new contact on the thread. A name alone is how duplicates get made.
 *  - The user's own address.
 *  - Role mailboxes, applicant-tracking systems and bulk senders (`classifySenderKind` is the
 *    rule the sweep already uses, so the two cannot disagree about what a person is).
 *  - A "name" that is a department or a mailbox rather than a person.
 *  - Anyone whose name trips the injection detector. The strings here were written by a model
 *    from someone else's mail and are shown to the user, so a suspicious one is dropped.
 *    A suspicious *title* is dropped alone: the person is still real.
 */
import { cleanSingleLine, detectInjectionSignals } from "@/lib/ai-security";
import { identityKeysFor } from "@/lib/duplicates";
import { classifySenderKind } from "@/lib/recruiter-triage";
import type { EmailEventKind, EmailEventPerson } from "./types";

export type InboxEventKind = Exclude<EmailEventKind, "other">;

/** An `email_events` row, as `loadInboxPeople` selects it. */
export type InboxEventRow = {
  id: string;
  kind: InboxEventKind;
  summary: string;
  occurred_at: string | Date;
  people: EmailEventPerson[] | null;
};

export type InboxCandidate = {
  /** The normalized address. The only thing a client ever sends back. */
  key: string;
  name: string;
  /** `personNameKey(name)`: how `contacts` and `ignored_people` are matched by name. */
  nameKey: string;
  title: string | null;
  eventId: string;
  kind: InboxEventKind;
  summary: string;
  at: Date;
};

/** Hiring updates first: the person who is moving your application matters most. */
const KIND_ORDER: Record<InboxEventKind, number> = { process_update: 0, job_posting: 1, event: 2, news: 3 };

/** The same rule as `normalizePersonKey` in `ignored-people.ts` (the smoke pins that they agree). */
export function personNameKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

/** A department or a mailbox rather than a person. */
const NOT_A_PERSON =
  /\b(team|recruiting|recruitment|recruiters?|talent|careers?|hiring|human resources|hr|support|notifications?|no-?reply|do not reply|admin|info|mailer|billing|sales|marketing)\b/i;

/** A person's name: two or more words, letters in each, no digits, no address, not a department. */
export function looksLikePerson(name: string): boolean {
  if (name.length < 3 || name.length > 60) return false;
  if (/[@\d<>\/\\]/.test(name)) return false;
  if (NOT_A_PERSON.test(name)) return false;
  const words = name.split(" ").filter(Boolean);
  return words.length >= 2 && words.every((w) => /\p{L}/u.test(w));
}

function emailKey(email: string | null | undefined): string | null {
  return identityKeysFor({ email }).find((k) => k.kind === "email")?.value ?? null;
}

function suspicious(value: string): boolean {
  return detectInjectionSignals(value).length > 0;
}

/**
 * The people to offer, best first. `rows` must be newest first (as the loader reads them), so
 * a person named in several emails is described by the newest. `selfEmails` are the user's own
 * addresses.
 */
export function pickInboxCandidates(rows: InboxEventRow[], selfEmails: string[], limit: number): InboxCandidate[] {
  const own = new Set(selfEmails.map((e) => emailKey(e)).filter((e): e is string => e !== null));
  const byKey = new Map<string, InboxCandidate>();

  for (const row of rows) {
    const summary = cleanSingleLine(row.summary, 140);
    if (!summary || suspicious(summary)) continue;
    for (const person of row.people ?? []) {
      const key = emailKey(person.email);
      if (!key || own.has(key) || byKey.has(key)) continue;
      if (classifySenderKind({ from: key, listUnsubscribe: "", listId: "", precedence: "" }) !== "human") continue;
      const name = cleanSingleLine(person.name, 60);
      if (!name || !looksLikePerson(name) || suspicious(name)) continue;
      const title = cleanSingleLine(person.title, 80);
      byKey.set(key, {
        key,
        name,
        nameKey: personNameKey(name),
        title: title && !suspicious(title) ? title : null,
        eventId: row.id,
        kind: row.kind,
        summary,
        at: new Date(row.occurred_at),
      });
    }
  }

  return [...byKey.values()]
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.at.getTime() - a.at.getTime() || (a.key < b.key ? -1 : 1))
    .slice(0, limit);
}
