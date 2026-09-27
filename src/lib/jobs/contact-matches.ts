/**
 * The roles that opened at a company somebody works for, for their profile.
 *
 * `matcher.ts` writes a `job_posting_matches` row for every hit and then, for the few that
 * clear its volume guards, one `ai_suggestion` naming the role. Until this file existed
 * NOTHING read that table: the bell said "an internship opened at Stripe, where you know
 * Ada" and linked to Ada's profile, which showed no trace of it. The posting's URL was
 * stored from the first commit and had never once been rendered.
 *
 * So the profile is where the ledger surfaces, and it deliberately shows MORE than the bell:
 *
 *   SUPPRESSED MATCHES TOO. The guards in `matcher.ts` — ten per run, five open suggestions,
 *   one per contact per run — exist to protect a NOTIFICATION CHANNEL from volume. Someone
 *   who has navigated to a person's profile is not being interrupted; they came looking.
 *   Suppressed rows are real matches that were never worth a bell, and this is the only
 *   place they have ever been visible.
 *
 *   CLOSED ROLES, MARKED. Ingest refreshes `active` on every sweep, so the feed tells us
 *   when a posting comes down — something the bell, which fires once and never updates, can
 *   never say. A role that has closed is still worth showing for a while (it is why the
 *   suggestion in your bell exists) but showing it as live would send somebody to a dead
 *   page, so `isOpen` is carried out and the row is rendered differently.
 *
 * ## The link is the one genuinely dangerous field here
 *
 * `matcher.ts` is emphatic that the notification panel's `url` is `/contacts/{id}` and never
 * the posting, because this text arrives from anonymous pull requests to a public repository
 * and a third-party link in the OS's own notification UI is a content-injection channel.
 * A profile page is a weaker setting than that — the person is already on the page, reading —
 * but the provenance is identical, so the protections are kept explicit rather than assumed:
 *
 *   1. `parseListing` only ever stores a URL whose parsed `protocol` is `https:`, dropping
 *      the posting outright otherwise.
 *   2. This file re-checks that on the way OUT anyway. Rule 1 ran in whatever version of the
 *      ingest was deployed the day the row was written, and a row older than a guard is
 *      exactly the row that gets through it. Re-validating costs one `new URL()` per row.
 *   3. `host` is returned beside the link so the component can show where a click actually
 *      goes. A link whose visible text is attacker-controlled and whose destination is not
 *      shown is the whole trick.
 *
 * Company and title were already run through `sanitizeAgentText` at ingest, so they are safe
 * to render as text — and they are rendered as text, never as markup or a link label alone.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { jobPostingMatches, jobPostings } from "@/db/schema";

export type ContactJobMatch = {
  matchId: string;
  postingId: string;
  title: string;
  companyName: string;
  /** Always https, re-validated on read. Null when the stored value no longer passes. */
  url: string | null;
  /** The link's destination, for the person to read before they click it. */
  host: string | null;
  locations: string[];
  datePosted: Date;
  /** Whether the feed still lists it. False means it came down after we told you about it. */
  isOpen: boolean;
  /** Why this company was being watched at all. */
  matchKind: "internship" | "referral";
  /** False when a volume guard kept it out of the bell. Shown here regardless. */
  wasNotified: boolean;
};

/**
 * Six is the cap because this is a supporting section on a long page, not a job board. The
 * plan was explicit that this pass adds no browsable list, and a contact at a large employer
 * can legitimately match dozens — which would push the timeline below the fold to show
 * twenty variations of the same role.
 */
export const MAX_CONTACT_JOB_MATCHES = 6;

/** An https URL and its host, or nulls. See the header: rule 2. */
function safeLink(raw: string): { url: string | null; host: string | null } {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") return { url: null, host: null };
    return { url: parsed.toString(), host: parsed.host };
  } catch {
    return { url: null, host: null };
  }
}

export async function listJobMatchesForContact(
  userId: string,
  contactId: string,
  limit = MAX_CONTACT_JOB_MATCHES
): Promise<{ rows: ContactJobMatch[]; hasMore: boolean }> {
  const db = await getDb();
  const found = await db
    .select({
      matchId: jobPostingMatches.id,
      matchKind: jobPostingMatches.matchKind,
      status: jobPostingMatches.status,
      postingId: jobPostings.id,
      title: jobPostings.title,
      companyName: jobPostings.companyName,
      url: jobPostings.url,
      locations: jobPostings.locations,
      datePosted: jobPostings.datePosted,
      active: jobPostings.active,
      isVisible: jobPostings.isVisible,
    })
    .from(jobPostingMatches)
    .innerJoin(jobPostings, eq(jobPostings.id, jobPostingMatches.postingId))
    .where(
      // `userId` is not redundant next to `contactId`: contact ids are uuids and unguessable,
      // but every read in this codebase scopes by user, and a read that relies on a uuid
      // being unguessable is one bad join away from being wrong.
      and(eq(jobPostingMatches.userId, userId), eq(jobPostingMatches.contactId, contactId))
    )
    // Still-open roles first — a closed one is history, and history does not need the top of
    // the list — then newest. The component renders in exactly this order, so sorting here
    // rather than there keeps the two from drifting.
    //
    // The expression has to be the SAME one `isOpen` is built from, not just `active`. A
    // posting with `active: true, is_visible: false` sorted among the live roles and then
    // rendered with a "Closed" badge, which reads as the list being in no order at all.
    // `smoke-contact-job-matches` caught exactly that.
    .orderBy(
      desc(sql`${jobPostings.active} and ${jobPostings.isVisible}`),
      desc(jobPostings.datePosted)
    )
    // One more than asked for, purely to learn whether there ARE more. Deliberately not a
    // count: a footnote does not justify a second query, and reporting `found.length` as a
    // total would print "and 1 more" for a contact with forty, which is worse than vague.
    .limit(limit + 1);

  const rows = found.slice(0, limit).map<ContactJobMatch>((r) => {
    const link = safeLink(r.url);
    return {
      matchId: r.matchId,
      postingId: r.postingId,
      title: r.title,
      companyName: r.companyName,
      url: link.url,
      host: link.host,
      locations: Array.isArray(r.locations) ? r.locations.slice(0, 3) : [],
      datePosted: r.datePosted,
      // `is_visible` is the feed's own "do not show this" flag and means the same thing to a
      // reader as `active: false` does, so the two are collapsed rather than given separate
      // labels nobody could tell apart.
      isOpen: r.active && r.isVisible,
      matchKind: r.matchKind,
      wasNotified: r.status === "notified",
    };
  });

  return { rows, hasMore: found.length > limit };
}
