/**
 * The one way to turn an incoming record into a contact.
 *
 * Every path that can create a contact goes through here — imports, calendar and event
 * ingest, the browser extension, note capture, the public API, MCP, and the manual "New
 * contact" form, which until now performed no duplicate check whatsoever and was therefore
 * the easiest way in the product to create a duplicate.
 *
 * ## Why this is not just "search, then insert"
 *
 * It is, plus one thing that matters: the insert is followed by a claim on
 * `contact_identities`, whose `UNIQUE (user_id, kind, value)` decides the race. A read
 * cannot do that. Two concurrent imports of the same LinkedIn profile both pass any
 * lookup — the second one's row simply does not exist yet when the first one checks — and
 * both write a contact. With the claim, exactly one of them keeps the identifier and the
 * other is told who has it, and merges into them.
 *
 * ## What merges automatically and what does not
 *
 * Everything the matcher is confident about, which is `DUPLICATE_MERGE_CONFIDENCE` and up:
 * every identifier tier, plus name+company (0.90) and name+title (0.85). Those fold without
 * asking. A bare full-name match (0.60) does not — two people genuinely can share a name and
 * nothing else — so both contacts are kept and the pair becomes a `duplicate_suggestions`
 * row for `/contacts/duplicates`.
 *
 * Automatic merging is safe here in a way it was not before: every merge archives the losing
 * contact whole in `contact_merges`, shows up in the recent-merges list, and can be undone.
 * The failure this replaced was calendar sync folding at 0.60 — a bare name — with no record
 * and no way back.
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import {
  DUPLICATE_MERGE_CONFIDENCE,
  buildDuplicateIndex,
  findDuplicateCandidatesIndexed,
  identityKeysFor,
  type DuplicateSubject,
} from "@/lib/duplicates";
import { claimIdentities, findIdentityOwners } from "@/lib/contact-identity";
import { mergeContacts, recordDuplicateSuggestion } from "@/lib/contact-merge";
import {
  createContactForUser,
  updateContactForUser,
  type ContactInput,
  type ContactWriteOptions,
} from "@/lib/contact-writes";

export type ResolveOutcome =
  /** No existing contact held any of this record's identifiers. */
  | "created"
  /** An identifier matched; the incoming data was folded into the contact that held it. */
  | "matched"
  /** Created, then lost an identifier race, and was merged into the winner. */
  | "merged";

export type ResolveResult = {
  contactId: string;
  outcome: ResolveOutcome;
  /** Why it matched, when it did. */
  reason?: string;
  /**
   * Name-tier lookalikes recorded for review. Never merged — surfaced so a caller with a
   * human in front of it (the extension, capture) can offer the choice immediately.
   */
  suggestions: { contactId: string; reason: string; confidence: number }[];
};

export type ResolveOptions = ContactWriteOptions & {
  /** Tag written onto the identity rows, for debugging a surprising merge later. */
  source?: string;
  /**
   * Skip recording name-tier lookalikes. For bulk importers that compute suggestions once
   * over the whole batch rather than per row.
   */
  skipSuggestions?: boolean;
};

/**
 * Which of two contacts survives a merge.
 *
 * Always the older row, tie-broken on the lower uuid. Deliberately NOT "the one that
 * already existed" or "the one I did not just create": the rule has to be a total order on
 * the rows themselves, so that two concurrent writers racing in opposite directions reach
 * the same answer instead of each merging into the other.
 */
async function pickWinner(userId: string, a: string, b: string): Promise<[string, string]> {
  const db = await getDb();
  const rows = await db
    .select({ id: contacts.id, createdAt: contacts.createdAt })
    .from(contacts)
    .where(and(eq(contacts.userId, userId), sql`${contacts.id} IN (${a}::uuid, ${b}::uuid)`));
  const byId = new Map(rows.map((r) => [r.id, r.createdAt?.getTime() ?? 0]));
  const at = byId.get(a);
  const bt = byId.get(b);
  if (at === undefined) return [b, a];
  if (bt === undefined) return [a, b];
  if (at !== bt) return at < bt ? [a, b] : [b, a];
  return a < b ? [a, b] : [b, a];
}

/**
 * Contacts sharing this record's full name, scored.
 *
 * Deliberately a narrow candidate set — contacts with the identical normalised name — rather
 * than the whole list, because this runs on every single write. That is enough for the tiers
 * that matter here (name+company, name+title, bare name), which all require an exact name
 * match anyway. The fuzzy near-miss tiers need a wider net and are left to the bulk paths,
 * which already hold a full `DuplicateIndex`, and to the review page's own scan.
 */
async function nameMatchesFor(
  userId: string,
  contactId: string | null,
  input: ContactInput
) {
  if (!input.fullName) return [];
  const db = await getDb();
  const candidates = (await db
    .select({
      id: contacts.id,
      fullName: contacts.fullName,
      email: contacts.email,
      linkedinUrl: contacts.linkedinUrl,
      xHandle: contacts.xHandle,
      company: contacts.company,
      title: contacts.title,
    })
    .from(contacts)
    .where(
      and(
        eq(contacts.userId, userId),
        contactId ? sql`${contacts.id} <> ${contactId}::uuid` : undefined,
        sql`lower(btrim(${contacts.fullName})) = ${input.fullName.trim().toLowerCase()}`
      )
    )
    .limit(25)) as DuplicateSubject[];
  if (!candidates.length) return [];

  return findDuplicateCandidatesIndexed(buildDuplicateIndex(candidates), {
    fullName: input.fullName,
    email: input.email,
    linkedinUrl: input.linkedinUrl,
    company: input.company,
    title: input.title,
  }).filter((m) => !m.strong);
}

/**
 * Record the pairs this write was NOT confident enough to merge.
 *
 * Only the sub-threshold ones. A match at or above `DUPLICATE_MERGE_CONFIDENCE` has already
 * been folded by the caller, and recording it as a question too would put a pair on the
 * review page that no longer has two sides.
 */
async function recordNameSuggestions(
  userId: string,
  contactId: string,
  matches: { contact: { id: string }; reason: string; confidence: number }[]
): Promise<ResolveResult["suggestions"]> {
  const unresolved = matches.filter((m) => m.confidence < DUPLICATE_MERGE_CONFIDENCE);
  for (const match of unresolved) {
    await recordDuplicateSuggestion(
      userId,
      contactId,
      match.contact.id,
      match.reason,
      match.confidence
    );
  }
  return unresolved.map((m) => ({
    contactId: m.contact.id,
    reason: m.reason,
    confidence: m.confidence,
  }));
}

/**
 * Resolve an incoming record to a contact, creating one only if nobody already owns its
 * identifiers.
 *
 * Returns the id of the contact that actually survives — never the id of a row this
 * function inserted and then merged away, which would hand the caller a uuid that no longer
 * exists.
 */
export async function resolveOrCreateContact(
  userId: string,
  input: ContactInput,
  options: ResolveOptions = {}
): Promise<ResolveResult> {
  const keys = identityKeysFor(input);

  // 1. Route on what already exists. This read cannot be trusted as a guard — the claim
  //    below is the guard — but it avoids creating a row we would immediately merge away
  //    in the overwhelmingly common non-concurrent case.
  if (keys.length) {
    const owners = await findIdentityOwners(userId, keys);
    const distinct = [...new Set(owners.map((o) => o.contactId))];

    if (distinct.length === 1) {
      const contactId = distinct[0];
      await updateContactForUser(userId, contactId, input, options);
      // The record may carry identifiers the existing contact lacks; claim those too.
      await claimIdentities(userId, contactId, keys, options.source);
      return {
        contactId,
        outcome: "matched",
        reason: owners.find((o) => o.contactId === contactId)?.key.kind,
        suggestions: [],
      };
    }

    if (distinct.length > 1) {
      // This record carries identifiers held by several different contacts, which means
      // those contacts are duplicates of each other and we have just been handed the
      // evidence. Collapse them, then write into the survivor.
      let survivor = distinct[0];
      for (const other of distinct.slice(1)) {
        const [winner, loser] = await pickWinner(userId, survivor, other);
        await mergeContacts(userId, winner, loser, {
          reason: "Shared identifier",
          confidence: 0.98,
          deferInvalidation: true,
        });
        survivor = winner;
      }
      await updateContactForUser(userId, survivor, input, options);
      await claimIdentities(userId, survivor, keys, options.source);
      return { contactId: survivor, outcome: "matched", reason: "Shared identifier", suggestions: [] };
    }
  }

  // 2. No identifier match. Try the name tiers before creating anything.
  //
  // Done BEFORE the insert, not after: folding into the existing contact avoids creating a
  // duplicate at all, rather than creating one and merging it away. It also keeps a free
  // user's contact cap from being consumed by a row that was never going to survive.
  const nameMatches = await nameMatchesFor(userId, null, input);
  const confident = nameMatches.find((m) => m.confidence >= DUPLICATE_MERGE_CONFIDENCE);

  if (confident) {
    const contactId = confident.contact.id;
    await updateContactForUser(userId, contactId, input, options);
    // The record may carry identifiers the matched contact lacks — an email for someone
    // previously known only by name. Claiming them now is what makes the NEXT write on this
    // person resolve by identifier instead of by name.
    if (keys.length) await claimIdentities(userId, contactId, keys, options.source);
    return {
      contactId,
      outcome: "matched",
      reason: confident.reason,
      // Weaker matches against other same-named contacts are still worth a question: this
      // record folded into one of them, and the rest may be duplicates of it too.
      suggestions: options.skipSuggestions
        ? []
        : await recordNameSuggestions(userId, contactId, nameMatches),
    };
  }

  // 3. Genuinely new, as far as anything can tell. Create, then claim.
  //
  // `createContactForUser` can throw PaywallError before inserting anything, in which case
  // there is no row to clean up and nothing has been claimed — the error propagates as-is.
  const created = await createContactForUser(userId, input, options);

  if (!keys.length) {
    // Nothing identifies this person, so no claim can be raced for. The unresolved name
    // lookalikes are the only signal there is.
    const suggestions = options.skipSuggestions
      ? []
      : await recordNameSuggestions(userId, created.id, nameMatches);
    return { contactId: created.id, outcome: "created", suggestions };
  }

  // 4. The claim. Anything returned that belongs to a different contact means we lost.
  const owners = await claimIdentities(userId, created.id, keys, options.source);
  const incumbent = owners.find((o) => o.contactId !== created.id);

  if (incumbent) {
    // Lost a race (or raced ourselves through two paths). Merge deterministically — older
    // wins — and hand back whichever id survives, not the one we inserted.
    const [winner, loser] = await pickWinner(userId, created.id, incumbent.contactId);
    await mergeContacts(userId, winner, loser, {
      reason: "Same identifier",
      confidence: 0.98,
    });
    return { contactId: winner, outcome: "merged", reason: incumbent.key.kind, suggestions: [] };
  }

  const suggestions = options.skipSuggestions
    ? []
    : await recordNameSuggestions(userId, created.id, nameMatches);
  return { contactId: created.id, outcome: "created", suggestions };
}
