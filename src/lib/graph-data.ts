import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, userGoals, userSettings } from "@/db/schema";
import type { UserProfile } from "@/lib/auth";
import { closenessTier } from "@/lib/closeness";
import { getClosenessCohortSlim } from "@/lib/closeness-cohort";
import { isCometContact, pickClusterComets } from "@/lib/comet";
import {
  buildConstellationClusters,
  toNamedGraphClusters,
} from "@/lib/constellation-clusters";
import { clientAvatarUrlSql } from "@/lib/contact-avatar-sql";
import { contactHasNotesSql } from "@/lib/contact-notes-sql";
import { getConstellationConfig } from "@/lib/constellation-config";
import { constellationEligibility } from "@/lib/constellation-eligibility";

/**
 * The constellation payload, as a plain function of `userId`.
 *
 * Lives here rather than in `src/actions/graph.ts` so the query-budget smoke test can
 * call it without a Clerk session or a request scope — the server action is a thin
 * wrapper that resolves the user and hands over the profile lookup as a promise.
 */
export type GraphCluster = {
  /** @deprecated use `name` — kept for UI that keyed on company */
  company: string;
  id: string;
  name: string;
  kind: "company" | "school" | "other";
  count: number;
  contactIds: string[];
};

export type UserSocialLinks = {
  linkedin?: string;
  twitter?: string;
  github?: string;
  website?: string;
};

/**
 * Which slice of the network to ship.
 *
 * `"engaged"` is the default and the product's intent: the chart is the people you actually
 * know. `"all"` is the explicit escape hatch behind the chart's "show all" control, fetched
 * only when someone asks for it.
 *
 * The distinction exists for weight, not just for looks. At 3,000 contacts this payload is
 * ~2.1 MB — 741 bytes a head — so shipping everyone and hiding most of them in the browser
 * would mean every visit paid the full cost of a view it wasn't showing. Filtering here is
 * what keeps the option to see everything from taxing the default.
 */
export type GraphScope = "engaged" | "all";

/** Most stars one payload carries, closest first. See `loadGraphData`. */
export const GRAPH_CONTACT_CAP = 5_000;

/** The text a star's panel shows, read only for the stars that ship. */
const DETAIL_COLUMNS = {
  id: true,
  aiSummary: true,
  keyFacts: true,
  howMet: true,
  metContext: true,
  dateMet: true,
  sharedInterests: true,
  email: true,
  phone: true,
  linkedinUrl: true,
  website: true,
} as const;

type ContactDetails = {
  aiSummary: string | null;
  keyFacts: string[] | null;
  howMet: string | null;
  metContext: string | null;
  dateMet: Date | null;
  sharedInterests: string[] | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  website: string | null;
};

const EMPTY_DETAILS: ContactDetails = {
  aiSummary: null,
  keyFacts: null,
  howMet: null,
  metContext: null,
  dateMet: null,
  sharedInterests: null,
  email: null,
  phone: null,
  linkedinUrl: null,
  website: null,
};

/** Ids per `IN (...)` when reading details; well under the bind-parameter cap. */
const DETAIL_ID_CHUNK = 2_000;

/**
 * Fill in the panel text for the contacts that ship. `everyone` skips the id list when the
 * whole network ships anyway (show all, or a network with no filter to apply).
 */
async function attachDetails(
  userId: string,
  shipped: Array<{ id: string } & ContactDetails>,
  everyone: boolean
): Promise<void> {
  if (!shipped.length) return;
  const db = await getDb();
  const ids = shipped.map((c) => c.id);
  const chunks = everyone ? [null] : Array.from({ length: Math.ceil(ids.length / DETAIL_ID_CHUNK) }, (_, i) => ids.slice(i * DETAIL_ID_CHUNK, (i + 1) * DETAIL_ID_CHUNK));
  const results = await Promise.all(
    chunks.map((chunk) =>
      db.query.contacts.findMany({
        where: chunk ? and(eq(contacts.userId, userId), inArray(contacts.id, chunk)) : eq(contacts.userId, userId),
        columns: DETAIL_COLUMNS,
      })
    )
  );
  const byId = new Map(results.flat().map((d) => [d.id, d]));
  for (const c of shipped) {
    const d = byId.get(c.id);
    if (!d) continue;
    c.aiSummary = d.aiSummary;
    c.keyFacts = d.keyFacts;
    c.howMet = d.howMet;
    c.metContext = d.metContext;
    c.dateMet = d.dateMet;
    c.sharedInterests = d.sharedInterests;
    c.email = d.email;
    c.phone = d.phone;
    c.linkedinUrl = d.linkedinUrl;
    c.website = d.website;
  }
}

export async function loadGraphData(
  userId: string,
  options: {
    profile: Promise<UserProfile | null> | UserProfile | null;
    scope?: GraphScope;
  }
) {
  const db = await getDb();

  // The network scan reads only what deciding and drawing need, for everyone. The wide text
  // a star's panel shows (summary, key facts, how you met, contact details) is read below for
  // the stars actually shipped, not for the whole network. At 3,000 contacts that text was
  // most of what this scan moved, for people the default view never draws.
  const [rows, goals, settings, closenessCohort, constellationConfig] = await Promise.all([
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      columns: {
        id: true,
        fullName: true,
        preferredName: true,
        company: true,
        school: true,
        title: true,
        relationshipScore: true,
        statedCloseness: true,
        // Constellation eligibility inputs.
        priorityLevel: true,
        constellationPin: true,
        lastInteractionAt: true,
        nextFollowUpAt: true,
      },
      extras: {
        avatarUrl: clientAvatarUrlSql.as("avatar_url"),
        // Computed, never the column: `notes` is multi-KB per row, and `smoke-page-budgets`
        // asserts it never appears bare in this scan.
        hasNotes: contactHasNotesSql.as("has_notes"),
      },
      with: { contactTags: { with: { tag: true } } },
    }),
    db.query.userGoals.findMany({
      where: eq(userGoals.userId, userId),
      orderBy: [desc(userGoals.createdAt)],
    }),
    db.query.userSettings.findFirst({
      where: eq(userSettings.userId, userId),
    }),
    // Slim: the chart uses four numbers per person, not every scoring factor. The full read
    // de-TOASTed each contact's whole breakdown to hand over those four. Nothing is donated:
    // the stored path never reads contacts, and the rare rebuild does its own wide scan.
    getClosenessCohortSlim(userId),
    // A one-row select on a singleton table.
    getConstellationConfig(),
  ]);

  const graphContacts = rows.map((c) => {
    const tags = c.contactTags.map((ct) => ct.tag.name);
    const breakdown = closenessCohort.byId.get(c.id);
    const dormant = isCometContact(c.lastInteractionAt);
    return {
      id: c.id,
      fullName: c.fullName,
      preferredName: c.preferredName,
      company: c.company,
      school: c.school,
      title: c.title,
      relationshipScore: c.relationshipScore,
      closeness: breakdown?.closeness ?? 0,
      closenessTier: breakdown?.tier ?? ("outer" as const),
      orbitScore: breakdown?.orbitScore ?? 1,
      lastInteractionAt: c.lastInteractionAt,
      hasLoggedInteraction: closenessCohort.interactedIds.has(c.id),
      nextFollowUpAt: c.nextFollowUpAt,
      tags,
      // The panel text is filled in below, for the contacts that ship. Same keys, same order
      // as before, so the payload's shape does not change.
      aiSummary: EMPTY_DETAILS.aiSummary,
      keyFacts: EMPTY_DETAILS.keyFacts,
      howMet: EMPTY_DETAILS.howMet,
      metContext: EMPTY_DETAILS.metContext,
      dateMet: EMPTY_DETAILS.dateMet,
      notes: null as string | null,
      sharedInterests: EMPTY_DETAILS.sharedInterests,
      email: EMPTY_DETAILS.email,
      phone: EMPTY_DETAILS.phone,
      linkedinUrl: EMPTY_DETAILS.linkedinUrl,
      website: EMPTY_DETAILS.website,
      profileImageUrl: c.avatarUrl,
      dormant,
      substantive: constellationEligibility(
        closenessCohort.constellationSignals.get(c.id),
        {
          pin: c.constellationPin,
          hasNotesText: Boolean(c.hasNotes),
          statedCloseness: c.statedCloseness,
          priorityLevel: c.priorityLevel,
          nextFollowUpAt: c.nextFollowUpAt,
          tagCount: tags.length,
        },
        constellationConfig.thresholds
      ).eligible,
    };
  });

  /*
   * The payload carries only what the chart will draw.
   *
   * An earlier cut shipped everyone and filtered in the browser, which kept a few things
   * trivially consistent but meant every visit paid the full weight of the unfiltered view —
   * ~2.1 MB at 3,000 contacts — to render a fraction of it. The option to see everything is
   * not allowed to tax the default, so the split happens here and `scope: "all"` is fetched
   * only when someone actually asks for it.
   *
   * What that costs, and why each is fine:
   *   - `summary.total` and `scoreCounts`: computed over ALL rows below, not the visible set,
   *     so the numbers keep describing the network rather than the picture.
   *   - The comet list: now scoped to people you have actually engaged with, which is what
   *     "re-engage" was always meant to mean — 400 LinkedIn connections you never spoke to
   *     were never really "drifting".
   */
  const eligibleCount = graphContacts.filter((c) => c.substantive).length;
  const filterActive = constellationConfig.enabled && options.scope !== "all";
  const candidates = filterActive ? graphContacts.filter((c) => c.substantive) : graphContacts;
  // "Show all" is capped, closest first. Past a few thousand stars the chart draws a dot
  // field, and at 50,000 contacts the uncapped payload was tens of megabytes for it.
  const capped = candidates.length > GRAPH_CONTACT_CAP;
  const visibleContacts = capped
    ? [...candidates].sort((a, b) => b.closeness - a.closeness || a.id.localeCompare(b.id)).slice(0, GRAPH_CONTACT_CAP)
    : candidates;
  await attachDetails(userId, visibleContacts, visibleContacts.length === rows.length);

  const { clusters: built } = buildConstellationClusters(visibleContacts);
  const clusters: GraphCluster[] = toNamedGraphClusters(built);

  // A few comets per cluster, not every year-quiet contact (see COMETS_PER_CLUSTER). Written onto
  // the payload so the red stars, the Re-engage list and the comet count all agree.
  const comets = pickClusterComets(visibleContacts, built);
  for (const c of visibleContacts) c.dormant = comets.has(c.id);

  // The filter dropdowns list what is actually on the chart. An option that can only ever
  // yield an empty sky is a dead end, and the user has no way to see why.
  const companies = [
    ...new Set(
      visibleContacts.map((c) => (c.company || "").trim()).filter(Boolean)
    ),
  ].sort((a, b) => a.localeCompare(b));

  const schools = [
    ...new Set(
      visibleContacts.map((c) => (c.school || "").trim()).filter(Boolean)
    ),
  ].sort((a, b) => a.localeCompare(b));

  const tags = [...new Set(visibleContacts.flatMap((c) => c.tags))];

  const scoreCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const dormantCount = comets.size;
  let overdueCount = 0;
  // Counted from the absolute score, not from the rings above: rings are quota
  // shares, so ring 4 + ring 5 is a fixed 22% of any network and would report
  // the same "strong ties" number however warm or cold things actually are.
  let strongTies = 0;
  for (const c of graphContacts) {
    const s = Math.min(5, Math.max(1, (c.orbitScore ?? c.relationshipScore) || 2));
    scoreCounts[s] = (scoreCounts[s] || 0) + 1;
    const raw = closenessCohort.byId.get(c.id)?.raw;
    if (raw != null && closenessTier(raw) !== "outer") strongTies += 1;
    if (c.nextFollowUpAt && new Date(c.nextFollowUpAt).getTime() < Date.now()) {
      overdueCount += 1;
    }
  }

  const socialLinks = (settings?.socialLinks || {}) as UserSocialLinks;
  // Awaited last so the Clerk profile round trip overlaps the scan, not precedes it.
  const profile = await options.profile;

  return {
    contacts: visibleContacts,
    companies,
    schools,
    tags,
    clusters,
    userId,
    summary: {
      total: rows.length,
      companyCount: companies.length,
      scoreCounts,
      strongTies,
      dormantCount,
      overdueCount,
      /**
       * What the chart is currently showing, and what it would show the other way.
       *
       * `available` is what makes the "show all" control honest: the chip can say how many
       * more there are without this payload having to carry them.
       */
      constellationFilter: {
        active: filterActive,
        /** True when the operator has the feature on at all, whatever this request asked for. */
        enabled: constellationConfig.enabled,
        scope: (options.scope ?? "engaged") as GraphScope,
        shown: visibleContacts.length,
        engaged: eligibleCount,
        available: graphContacts.length,
        /** True when more matched than `GRAPH_CONTACT_CAP`; the closest are shown. */
        capped,
      },
      userName: profile?.name || "You",
      userImageUrl: profile?.imageUrl || null,
      userEmail: profile?.email || null,
      socialLinks,
      goals: goals
        .filter((g) => g.active === 1)
        .map((g) => ({ id: g.id, text: g.text })),
    },
  };
}

