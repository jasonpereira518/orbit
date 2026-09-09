/**
 * Deciding whether two roster lines describe the same person.
 *
 * This MIRRORS `participantIdentityKey` in `src/lib/ingest/events.ts` — same precedence,
 * same normalisation, same `prefix:value` shape. It is a deliberate second copy rather than
 * an import because that function is private to the ingest module and the two serve different
 * moments: this one dedupes rows as a roster is stored, that one dedupes participants as an
 * event is written. They must agree, or a roster that looks like 40 people becomes 38 contacts
 * and nobody can see why.
 *
 * If ingest's precedence ever changes, change it here too — `smoke-event-roster` asserts the
 * two produce identical keys for the same person, so the drift shows up as a failing test
 * rather than as quietly missing people.
 *
 * Strongest available signal wins. This is only "are these two lines the same person"; real
 * cross-contact matching is `src/lib/duplicates.ts`'s job and must not be reimplemented here.
 */

export type AttendeeIdentityInput = {
  linkedinUrl?: string | null;
  email?: string | null;
  xHandle?: string | null;
  fullName?: string | null;
};

/**
 * Returns null when a row carries nothing to identify a person by. Such a row is dropped
 * rather than stored: `identity_key` is NOT NULL and unique per event, so a nameless row
 * would either fail the insert or collide with every other nameless row.
 */
export function attendeeIdentityKey(input: AttendeeIdentityInput): string | null {
  const linkedin = input.linkedinUrl?.trim().toLowerCase();
  if (linkedin) return `li:${linkedin}`;
  const email = input.email?.trim().toLowerCase();
  if (email) return `em:${email}`;
  const handle = input.xHandle?.trim().toLowerCase().replace(/^@/, "");
  if (handle) return `hd:${handle}`;
  const name = input.fullName?.trim().toLowerCase().replace(/\s+/g, " ");
  if (name) return `nm:${name}`;
  return null;
}
