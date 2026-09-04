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
import { formatExperienceDates } from "@/lib/contact-profile-format";
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

/** The focused contact's profile as plain text — one section per heading, no JSON. */
function renderFocusProfile(profile: Awaited<ReturnType<typeof getContactProfile>>): string | null {
  if (!profile) return null;
  const lines: string[] = [];
  if (profile.headline) lines.push(profile.headline);
  if (profile.about) lines.push(`About: ${profile.about}`);

  const roles = profile.experiences.filter((e) => e.kind === "role");
  if (roles.length) {
    lines.push("Experience:");
    for (const role of roles) {
      const dates = formatExperienceDates(role);
      const head = [role.title, role.organization].filter(Boolean).join(" at ");
      lines.push(`- ${head}${dates ? ` (${dates})` : ""}`);
      if (role.description) lines.push(`  ${role.description}`);
    }
  }

  const schools = profile.experiences.filter((e) => e.kind === "education");
  if (schools.length) {
    lines.push("Education:");
    for (const school of schools) {
      const detail = [school.title, school.fieldOfStudy].filter(Boolean).join(", ");
      const dates = formatExperienceDates(school);
      lines.push(`- ${school.organization}${detail ? ` — ${detail}` : ""}${dates ? ` (${dates})` : ""}`);
    }
  }

  if (profile.skills.length) {
    lines.push(`Skills: ${profile.skills.map((s) => s.name).join(", ")}`);
  }
  if (profile.certifications.length) {
    lines.push(
      `Certifications: ${profile.certifications
        .map((c) => [c.name, c.issuer].filter(Boolean).join(" — "))
        .join("; ")}`
    );
  }
  if (profile.volunteering.length) {
    lines.push(
      `Volunteering: ${profile.volunteering
        .map((v) => [v.role, v.organization].filter(Boolean).join(" at "))
        .join("; ")}`
    );
  }
  if (profile.publications.length) {
    lines.push(`Publications: ${profile.publications.map((p) => p.title).join("; ")}`);
  }

  // Provenance, so the model does not present an Apollo guess as the person's own words.
  lines.push(
    profile.source === "extension"
      ? "(Captured from their LinkedIn profile page.)"
      : "(From a third-party data provider, not their LinkedIn page directly.)"
  );
  return lines.join("\n");
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

  let focusProfile: string | null = null;
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

      focusProfile = renderFocusProfile(
        await getContactProfile(userId, focusContactId).catch(() => null)
      );
    }
  }

  // Depends on the retrieval above, so it runs after — with the pinned contact's own
  // interactions and the retrieved page's career lines alongside, since those are
  // independent of each other and of the search.
  const retrievedIds = retrieved.map((c) => c.id);
  const [snippets, careerLines, focusMsgs] = await Promise.all([
    loadKnowledgeSnippets(userId, retrievedIds),
    getCareerLines(userId, retrievedIds).catch(() => new Map<string, string>()),
    focusContactId
      ? db.query.interactions.findMany({
          where: and(eq(interactions.userId, userId), eq(interactions.contactId, focusContactId)),
          orderBy: [desc(interactions.interactionDate)],
          limit: 16,
        })
      : Promise.resolve([]),
  ]);
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
