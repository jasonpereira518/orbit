import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
  chatMessages,
  chatThreads,
  contacts,
  interactions,
  userGoals,
  type ChatRecommendation,
} from "@/db/schema";
import { getAttentionBrief, isAttentionQuestion, type AttentionBrief } from "@/lib/chat-attention";
import {
  budgetContactsContext,
  CANDIDATE_POOL,
  rerankCandidates,
  understandQuery,
} from "@/lib/chat-retrieval";
import { findOrgRosters, type OrgRoster } from "@/lib/chat-roster";
import { getClosenessCohort } from "@/lib/closeness-cohort";
import { getCareerLines, getContactProfile } from "@/lib/contact-profile";
import {
  formatExperienceDates,
  sanitizeProfileLine,
  sanitizeProfileText,
} from "@/lib/contact-profile-format";
import { getQueryEmbedding } from "@/lib/embedding-cache";
import { hybridSearchContacts, type RankedContact } from "@/lib/hybrid-search";
import { isRecruiterIntent } from "@/lib/recruiters";
import { loadRecruitersForChat } from "@/actions/recruiters";

/**
 * Everything the model is shown for one question, assembled with the independent lookups
 * running side by side.
 *
 * Shared by the streaming route (`/api/chat`) and the `askNetwork` server action so the
 * two cannot drift. The chain used to run strictly in sequence — search, then rosters,
 * then the attention brief, then recruiters, then the thread — although only the knowledge
 * snippets depend on the search results; the rest read `q` and `userId` alone.
 *
 * Retrieval is itself a three-stage pipeline (query embedding + parse, hybrid search, flash
 * rerank) that runs as one unit alongside everything else here — none of the other lookups
 * depend on it, so it competes for time rather than blocking any of them.
 */

const PRIOR_TURN_LIMIT = 8;

export type ChatTurn = { role: "user" | "assistant"; content: string };

type Recruiters = Awaited<ReturnType<typeof loadRecruitersForChat>>;
type BudgetedContact = ReturnType<typeof budgetContactsContext>[number];

export type ChatContext = {
  q: string;
  thread: { id: string; title: string | null } | null;
  priorTurns: ChatTurn[];
  retrieved: RankedContact[];
  snippets: Map<string, { recentMessages: string[] }>;
  scopedQuestion: string;
  orgRosters: OrgRoster[];
  attention: AttentionBrief | null;
  recruitersForChat: Recruiters;
  /** Contacts the model may recommend: budgeted-in, on a roster, or in the attention brief. */
  allowedContacts: Set<string>;
  allowedRecruiters: Set<string>;
  /** The `contactsContext` argument of `chatWithNetwork`. */
  modelContacts: BudgetedContact[];
  /** The `recruitersContext` argument of `chatWithNetwork`. */
  modelRecruiters: Array<{
    id: string;
    fullName: string;
    firm: string | null;
    specialty: string[];
    avgRating: number;
    logCount: number;
    personalRating: number | null;
    status: string | null;
    notes: string | null;
    piiUnlocked: boolean;
    relevance: number;
  }>;
  /** Drop recommendations pointing at people the user does not actually have. */
  filterRecommendations: (raw: ChatRecommendation[]) => ChatRecommendation[];
  /**
   * The focused contact's whole LinkedIn profile, already rendered as text.
   *
   * Deliberately outside `budgetContactsContext`: it is one contact, asked about directly
   * on their own page, and the tiered trimming exists to ration space across many
   * retrieved people. Rationing the subject of the question is the wrong trade.
   */
  focusProfile: string | null;
};

async function loadKnowledgeSnippets(
  userId: string,
  contactIds: string[]
): Promise<Map<string, { recentMessages: string[] }>> {
  const result = new Map<string, { recentMessages: string[] }>();
  if (!contactIds.length) return result;

  const db = await getDb();
  const msgs = await db.query.interactions.findMany({
    where: and(
      eq(interactions.userId, userId),
      inArray(interactions.contactId, contactIds),
      eq(interactions.interactionType, "linkedin_message")
    ),
    orderBy: [desc(interactions.interactionDate)],
    limit: contactIds.length * 8,
  });

  const byContact = new Map<string, string[]>();
  for (const m of msgs) {
    const list = byContact.get(m.contactId) || [];
    if (list.length >= 6) continue;
    const text = (m.aiSummary || m.rawNotes || "").trim();
    if (!text) continue;
    list.push(text.slice(0, 280));
    byContact.set(m.contactId, list);
  }

  for (const id of contactIds) {
    result.set(id, { recentMessages: byContact.get(id) || [] });
  }
  return result;
}

async function loadActiveGoalTexts(userId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.query.userGoals
    .findMany({
      where: and(eq(userGoals.userId, userId), eq(userGoals.active, 1)),
      columns: { text: true },
      orderBy: [desc(userGoals.createdAt)],
      limit: 5,
    })
    .catch(() => []);
  return rows.map((g) => g.text);
}

/** Stage 0-3: query embedding + parse (parallel), wide hybrid retrieval, flash rerank. */
async function retrieveRankedContacts(
  userId: string,
  q: string
): Promise<RankedContact[]> {
  const activeGoals = await loadActiveGoalTexts(userId);
  const [queryEmbedding, parsedQuery] = await Promise.all([
    getQueryEmbedding(userId, q).catch(() => null),
    understandQuery(userId, q, activeGoals),
  ]);
  const candidates = await hybridSearchContacts(userId, {
    query: q,
    embedding: queryEmbedding,
    filters: parsedQuery.filters,
    expansionTerms: parsedQuery.expansionTerms,
    limit: CANDIDATE_POOL,
  });
  return rerankCandidates(userId, q, candidates);
}

// Every field below is written by the profile's owner, so it is exactly as
// attacker-controlled as the scraped page text `untrustedPageBlock` sanitizes — same
// treatment here, applied at render time so the write path (`saveContactProfile`) does not
// have to know which of its callers eventually reach a model prompt.
/** A value that must render on one line — headings, org/title/field names. */
function focusLine(value: string | null | undefined): string | null {
  if (!value) return null;
  const clean = sanitizeProfileLine(value);
  return clean || null;
}
/** A value that may be prose spanning multiple lines — About, a role's description. */
function focusProse(value: string | null | undefined): string | null {
  if (!value) return null;
  const clean = sanitizeProfileText(value);
  return clean || null;
}

// Generous but real ceilings: `saveContactProfile` bounds each individual field's length
// but not the number of experience rows, and `about` alone can already be 8000 chars. A
// pathological profile (dozens of roles, max-length text everywhere) must not be able to
// blow the prompt out to hundreds of KB or a provider's context limit for one contact — so
// this block gets its own cap even though it deliberately sits outside the shared budget in
// `budgetContactsContext`.
const FOCUS_PROFILE_MAX_ROLES = 20;
const FOCUS_PROFILE_MAX_SCHOOLS = 10;
const FOCUS_PROFILE_MAX_CHARS = 12_000;

/**
 * The focused contact's profile as plain text — one section per heading, no JSON.
 * Exported so a smoke test can drive it directly with a hostile profile and inspect the
 * sanitized output, without going through the DB-backed `prepareChatContext`.
 */
export function renderFocusProfile(profile: Awaited<ReturnType<typeof getContactProfile>>): string | null {
  if (!profile) return null;
  const lines: string[] = [];
  const headline = focusLine(profile.headline);
  if (headline) lines.push(headline);
  const about = focusProse(profile.about);
  if (about) lines.push(`About: ${about}`);

  const roles = profile.experiences.filter((e) => e.kind === "role");
  if (roles.length) {
    lines.push("Experience:");
    for (const role of roles.slice(0, FOCUS_PROFILE_MAX_ROLES)) {
      const dates = formatExperienceDates(role);
      const head = [focusLine(role.title), focusLine(role.organization)]
        .filter(Boolean)
        .join(" at ");
      lines.push(`- ${head}${dates ? ` (${dates})` : ""}`);
      const description = focusProse(role.description);
      if (description) lines.push(`  ${description}`);
    }
    if (roles.length > FOCUS_PROFILE_MAX_ROLES) {
      lines.push(`  (+${roles.length - FOCUS_PROFILE_MAX_ROLES} more roles omitted)`);
    }
  }

  const schools = profile.experiences.filter((e) => e.kind === "education");
  if (schools.length) {
    lines.push("Education:");
    for (const school of schools.slice(0, FOCUS_PROFILE_MAX_SCHOOLS)) {
      const detail = [focusLine(school.title), focusLine(school.fieldOfStudy)]
        .filter(Boolean)
        .join(", ");
      const dates = formatExperienceDates(school);
      const organization = focusLine(school.organization) ?? "";
      lines.push(`- ${organization}${detail ? ` — ${detail}` : ""}${dates ? ` (${dates})` : ""}`);
    }
    if (schools.length > FOCUS_PROFILE_MAX_SCHOOLS) {
      lines.push(`  (+${schools.length - FOCUS_PROFILE_MAX_SCHOOLS} more schools omitted)`);
    }
  }

  if (profile.skills.length) {
    const names = profile.skills.map((s) => focusLine(s.name)).filter(Boolean);
    if (names.length) lines.push(`Skills: ${names.join(", ")}`);
  }
  if (profile.certifications.length) {
    const items = profile.certifications
      .map((c) => [focusLine(c.name), focusLine(c.issuer)].filter(Boolean).join(" — "))
      .filter(Boolean);
    if (items.length) lines.push(`Certifications: ${items.join("; ")}`);
  }
  if (profile.volunteering.length) {
    const items = profile.volunteering
      .map((v) => [focusLine(v.role), focusLine(v.organization)].filter(Boolean).join(" at "))
      .filter(Boolean);
    if (items.length) lines.push(`Volunteering: ${items.join("; ")}`);
  }
  if (profile.publications.length) {
    const titles = profile.publications.map((p) => focusLine(p.title)).filter(Boolean);
    if (titles.length) lines.push(`Publications: ${titles.join("; ")}`);
  }

  // Provenance, so the model does not present an Apollo guess as the person's own words.
  lines.push(
    profile.source === "extension"
      ? "(Captured from their LinkedIn profile page.)"
      : "(From a third-party data provider, not their LinkedIn page directly.)"
  );

  const rendered = lines.join("\n");
  if (rendered.length <= FOCUS_PROFILE_MAX_CHARS) return rendered;
  return `${rendered.slice(0, FOCUS_PROFILE_MAX_CHARS)}\n(profile truncated at ${FOCUS_PROFILE_MAX_CHARS} characters)`;
}

export async function prepareChatContext(
  userId: string,
  question: string,
  options: { threadId?: string | null; focusContactId?: string | null }
): Promise<ChatContext> {
  const db = await getDb();
  const q = question.trim();
  if (!q) throw new Error("Question is required");
  const threadId = options.threadId ?? null;
  const focusContactId = options.focusContactId?.trim() || null;

  // Everything that depends only on the question and the user, at once. Retrieval is its
  // own multi-stage pipeline (see retrieveRankedContacts) that runs as one unit here.
  const [thread, priorRows, retrieved, orgRosters, attention, recruitersForChat] =
    await Promise.all([
      threadId
        ? db.query.chatThreads.findFirst({
            where: and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)),
            columns: { id: true, title: true },
          })
        : Promise.resolve(null),
      threadId
        ? db.query.chatMessages.findMany({
            where: and(eq(chatMessages.threadId, threadId), eq(chatMessages.userId, userId)),
            orderBy: [desc(chatMessages.createdAt)],
            limit: PRIOR_TURN_LIMIT,
            columns: { role: true, content: true },
          })
        : Promise.resolve([]),
      retrieveRankedContacts(userId, q),
      // Exhaustive membership for any organisation the question names — the one thing a
      // relevance-ranked top-K cannot supply. Never fatal.
      findOrgRosters(userId, q).catch(() => [] as OrgRoster[]),
      // Who the dashboard would say needs attention, only for questions that ask.
      isAttentionQuestion(q)
        ? getClosenessCohort(userId)
            .catch(() => null)
            .then((cohort) => getAttentionBrief(userId, cohort?.interactedIds))
            .catch(() => null)
        : Promise.resolve(null),
      isRecruiterIntent(q) ? loadRecruitersForChat(q, 8) : Promise.resolve([] as Recruiters),
    ]);

  if (threadId && !thread) throw new Error("Chat not found");

  const priorTurns: ChatTurn[] = priorRows
    .slice()
    .reverse()
    .map((m) => ({ role: m.role as ChatTurn["role"], content: m.content }));

  if (focusContactId) {
    const focused = await db.query.contacts.findFirst({
      where: and(eq(contacts.id, focusContactId), eq(contacts.userId, userId)),
      with: { contactTags: { with: { tag: true } } },
    });
    if (focused) {
      const focusEntry: RankedContact = {
        id: focused.id,
        fullName: focused.fullName,
        preferredName: focused.preferredName,
        company: focused.company,
        school: focused.school,
        title: focused.title,
        location: focused.location,
        email: focused.email,
        industry: focused.industry,
        notes: focused.notes,
        aiSummary: focused.aiSummary,
        keyFacts: focused.keyFacts || [],
        relationshipScore: focused.relationshipScore,
        priorityLevel: focused.priorityLevel,
        closenessTier: focused.closenessTier,
        tags: focused.contactTags.map((ct) => ct.tag.name),
        rrfScore: 1,
        relevance: 1,
        matchedArms: [],
        filterMatched: true,
      };
      const without = retrieved.filter((c) => c.id !== focusContactId);
      retrieved.splice(0, retrieved.length, focusEntry, ...without.slice(0, 11));
    }
  }

  // Depends on the retrieval above, so it runs after — with the pinned contact's own
  // interactions, the retrieved page's career lines, and the pinned contact's own full
  // profile alongside, since all four are independent of each other and of the search.
  // `getContactProfile` does not depend on `focused` above — it is scoped by userId and
  // contactId and simply returns null for a contact the user does not own — so it belongs
  // in this parallel batch rather than a serial await gated on that lookup.
  const retrievedIds = retrieved.map((c) => c.id);
  const [snippets, careerLines, focusMsgs, focusProfileData] = await Promise.all([
    loadKnowledgeSnippets(userId, retrievedIds),
    getCareerLines(userId, retrievedIds).catch(() => new Map<string, string>()),
    focusContactId
      ? db.query.interactions.findMany({
          where: and(eq(interactions.userId, userId), eq(interactions.contactId, focusContactId)),
          orderBy: [desc(interactions.interactionDate)],
          limit: 16,
        })
      : Promise.resolve([]),
    focusContactId
      ? getContactProfile(userId, focusContactId).catch(() => null)
      : Promise.resolve(null),
  ]);
  const focusProfile = renderFocusProfile(focusProfileData);
  if (focusContactId) {
    snippets.set(focusContactId, {
      recentMessages: focusMsgs
        .map((m) => (m.aiSummary || m.rawNotes || "").trim())
        .filter(Boolean)
        .slice(0, 12)
        .map((t) => t.slice(0, 320)),
    });
  }

  const scopedQuestion = focusContactId
    ? `[Focus: answer primarily about the pinned contact id=${focusContactId}. You may use other contacts only for intros/context.]\n\n${q}`
    : q;

  // Sized by rank under a total char budget — a later, cheaper contact must not be
  // appended out of rank order once the budget runs dry, so this can be a strict prefix
  // of `retrieved`.
  const modelContacts = budgetContactsContext(retrieved, snippets, careerLines);

  // Roster and attention contacts are as legitimate a recommendation as retrieved ones —
  // they came from the same user's own rows — so they must not be filtered out for being
  // outside the retrieval pass. But the retrieval side of the allow-list must reflect what
  // the model actually saw, not everything retrieved — budgetContactsContext can drop
  // trailing contacts once the char budget runs out.
  const allowedContacts = new Set([
    ...modelContacts.map((c) => c.id),
    ...orgRosters.flatMap((r) => r.people.map((p) => p.id)),
    ...(attention?.overdue.map((c) => c.id) ?? []),
    ...(attention?.suggestions.map((c) => c.id) ?? []),
  ]);
  const allowedRecruiters = new Set(recruitersForChat.map((r) => r.id));
  const maxScore = Math.max(1, ...recruitersForChat.map((r) => r.score));

  return {
    q,
    thread: thread ?? null,
    priorTurns,
    retrieved,
    snippets,
    scopedQuestion,
    orgRosters,
    attention,
    recruitersForChat,
    allowedContacts,
    allowedRecruiters,
    modelContacts,
    focusProfile,
    modelRecruiters: recruitersForChat.map((r) => ({
      id: r.id,
      fullName: r.fullName,
      firm: r.firm,
      specialty: r.specialty,
      avgRating: r.avgRating,
      logCount: r.logCount,
      personalRating: r.personalRating,
      status: r.status,
      notes: r.notes,
      piiUnlocked: r.piiUnlocked,
      relevance: r.score / maxScore,
    })),
    filterRecommendations: (raw) =>
      (raw || []).filter((r) => {
        if (r.recruiter_id) return allowedRecruiters.has(r.recruiter_id);
        if (r.contact_id) return allowedContacts.has(r.contact_id);
        return false;
      }),
  };
}
