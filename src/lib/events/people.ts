/**
 * Recognising the same person across two different events.
 *
 * ## Why `identity_key` cannot do this job
 *
 * `event_attendees.identity_key` keys on the string it was given — `li:https://linkedin.com/in/jane`
 * and `li:https://www.linkedin.com/in/jane/` are different keys. That is exactly right for what
 * it does (making a re-paste of one roster idempotent against a unique index, where changing
 * the normalisation would break every stored row), and useless for asking "did I meet this
 * person at three events", where the two spellings are the same human.
 *
 * So a second key, normalised the way the rest of Orbit normalises identity, and stored
 * alongside rather than replacing it.
 *
 * ## The precedence, and what the last rung costs
 *
 * `linkedin_slug` > `email` > `x_handle` > `platform_user` > `name`.
 *
 * The kinds match `contact_identities.kind` deliberately: that table has a unique index on
 * `(user_id, kind, value)`, so the cross-event aggregate can join through it and find "this
 * roster row and that contact are the same person" without a second matching implementation.
 *
 * `name` is the weak rung and is treated as such everywhere it is used. Two people called
 * David Kim at two different meetups are not a pattern, and a UI that says "you keep running
 * into David Kim" about them is worse than saying nothing. Name-tier clusters are marked, and
 * the panel that renders them hides those by default.
 *
 * Pure: no network, no database.
 */
import { linkedinSlug, normalizeXHandle } from "@/lib/duplicates";
import { isRoleEmail } from "@/lib/events/discovery/from-calendar";

export type PersonKeyKind = "linkedin_slug" | "email" | "x_handle" | "platform_user" | "name";

export type PersonKey = { kind: PersonKeyKind; value: string };

/** A name worth keying on: at least two tokens, at least one letter in each. */
function nameKey(fullName: string | null | undefined): string | null {
  const cleaned = (fullName ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!cleaned) return null;
  const tokens = cleaned.split(" ").filter((token) => /\p{L}/u.test(token));
  // One token is a first name. "Ada" from a Partiful guest list is not an identity — that
  // platform shows first names only, and half a room would collapse into one person.
  return tokens.length >= 2 ? tokens.join(" ") : null;
}

/**
 * The strongest key this roster row supports, or null when nothing identifies them.
 *
 * `externalRef` is a platform's own user id, already namespaced by the platform that issued
 * it (`luma:usr-…`) — a Luma id and a Partiful id are only unique within their own platform.
 */
export function personKeyOf(input: {
  linkedinUrl?: string | null;
  email?: string | null;
  xHandle?: string | null;
  externalRef?: string | null;
  fullName?: string | null;
}): PersonKey | null {
  const linkedin = linkedinSlug(input.linkedinUrl);
  if (linkedin) return { kind: "linkedin_slug", value: linkedin };

  const email = input.email?.trim().toLowerCase();
  // Role addresses identify an inbox, not a person: `events@acme.com` at four events is one
  // shared mailbox, and treating it as somebody you keep meeting is nonsense.
  if (email && email.includes("@") && !isRoleEmail(email)) {
    return { kind: "email", value: email };
  }

  const handle = normalizeXHandle(input.xHandle);
  if (handle) return { kind: "x_handle", value: handle };

  // Only a namespaced ref. A bare `usr-123` could belong to any platform.
  const external = input.externalRef?.trim().toLowerCase();
  if (external && external.includes(":")) return { kind: "platform_user", value: external };

  const name = nameKey(input.fullName);
  return name ? { kind: "name", value: name } : null;
}

/** Name-tier clusters are shown differently, and hidden by default. */
export function isWeakKey(kind: PersonKeyKind | null | undefined): boolean {
  return kind === "name";
}
