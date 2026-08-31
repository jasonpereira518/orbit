import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  recruiterOpportunities,
  recruiterScanFindings,
  recruiterScanVerdicts,
  recruiterThreads,
  userRecruiterLinks,
  type RecruiterFindingStatus,
} from "@/db/schema";
import { displayCompanyName, normalizeCompanyName, resolveCompany } from "@/lib/companies";
import { RECRUITER_PROMPT_VERSION } from "@/lib/recruiter-scan-state";
import {
  mergeStage,
  type RecruiterStage,
  type StageObservation,
} from "@/lib/recruiter-stages";
import { ensureUserLink, upsertCanonicalRecruiter } from "@/lib/recruiters";

/**
 * Turns a classified thread into rows.
 *
 * There is exactly one write path here, used by both the automatic high-confidence case and
 * the manual approve-from-review case. That is deliberate: two paths would drift, and the
 * reviewed one is the one nobody exercises until it is already wrong.
 */

export type ThreadFinding = {
  gmailThreadId: string;
  subject: string;
  senderKind: "human" | "ats";
  direction: "inbound" | "outbound";
  /** Null for automated mail — an ATS robot is not a contact worth keeping. */
  correspondentEmail: string | null;
  correspondentName: string | null;
  recruiterFirm: string | null;
  hiringCompany: string | null;
  roles: string[];
  stage: RecruiterStage;
  stageEvidence: string | null;
  summary: string | null;
  nextStep: string | null;
  confidence: number;
  messageCount: number;
  userReplied: boolean;
  firstMessageAt: Date | null;
  lastMessageAt: Date | null;
};

/** Confidence is stored as an integer percent — jsonb-free and trivially sortable in SQL. */
function pct(confidence: number): number {
  return Math.max(0, Math.min(100, Math.round(confidence * 100)));
}

/**
 * Legal-entity suffixes, stripped from the merge key only.
 *
 * Kept short and strictly legal on purpose. Words like "group", "labs" or "technologies" are
 * tempting to add and would over-merge genuinely distinct companies, which is far worse here
 * than leaving two rows that a person can see are the same.
 */
const LEGAL_SUFFIX_RE =
  /\s+(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|gmbh|plc|ag|bv|nv|sa|srl|oy|ab|pty|pte|kk)$/;

/**
 * The key by which threads are folded into one hiring process.
 *
 * Deliberately stronger than `normalizeCompanyName`, which only lowercases and collapses
 * whitespace. That is the right key for the `companies` table, where over-merging two of the
 * user's contacts' employers would be a real loss — but here it leaves "Stripe" and
 * "Stripe, Inc." as two separate pipelines for one job search, which is exactly the
 * fragmentation this feature exists to remove. An LLM naming the same employer two ways
 * across two threads is the normal case, not the edge case.
 */
export function normalizeOpportunityCompany(raw: string): string {
  let key = normalizeCompanyName(raw)
    .replace(/[.,]/g, "")
    .replace(/^the\s+/, "")
    .replace(/\s+/g, " ")
    .trim();

  // Twice, so "Foo Co., Ltd." reduces fully.
  key = key.replace(LEGAL_SUFFIX_RE, "").replace(LEGAL_SUFFIX_RE, "").trim();
  return key;
}

function mergeRoles(existing: string[] | null, incoming: string[]): string[] {
  const seen = new Map<string, string>();
  for (const role of [...(existing ?? []), ...incoming]) {
    const key = role.trim().toLowerCase();
    if (key && !seen.has(key)) seen.set(key, role.trim());
  }
  return [...seen.values()].slice(0, 12);
}

/**
 * Finds or creates the process this thread belongs to, and folds the thread's stage into it.
 *
 * Merged on `normalizeOpportunityCompany`, which is stricter than the key the `companies`
 * table uses — see that function for why the two deliberately differ. The `company_id` link
 * still goes through the ordinary resolver, so a process joins the rest of the CRM even
 * though its own merge key is its own.
 */
async function upsertOpportunity(
  userId: string,
  finding: ThreadFinding
): Promise<{ id: string; created: boolean } | null> {
  const rawName = finding.hiringCompany || finding.recruiterFirm;
  const display = rawName ? displayCompanyName(rawName) : "";
  if (!display) return null;

  const normalized = normalizeOpportunityCompany(display);
  if (!normalized) return null;

  const db = await getDb();
  const at = finding.lastMessageAt ?? new Date();

  const existing = await db.query.recruiterOpportunities.findFirst({
    where: and(
      eq(recruiterOpportunities.userId, userId),
      eq(recruiterOpportunities.companyNormalized, normalized)
    ),
  });

  if (!existing) {
    // Link to the user's company row so the pipeline joins the rest of the CRM. Best-effort:
    // a company that cannot be resolved still gets an opportunity, just an unlinked one.
    const company = await resolveCompany(userId, display).catch(() => null);
    const [created] = await db
      .insert(recruiterOpportunities)
      .values({
        userId,
        companyId: company?.id ?? null,
        companyName: company?.name ?? display,
        companyNormalized: normalized,
        stage: finding.stage,
        stageUpdatedAt: at,
        stageEvidence: finding.stageEvidence,
        roles: mergeRoles(null, finding.roles),
        summary: finding.summary,
        nextStep: finding.nextStep,
        firstActivityAt: finding.firstMessageAt,
        lastActivityAt: finding.lastMessageAt,
        threadCount: 1,
        confidence: pct(finding.confidence),
        source: "gmail_scan",
      })
      .onConflictDoNothing()
      .returning();

    if (created) return { id: created.id, created: true };
    // Lost a race with a concurrent invocation — fall through and merge into the winner.
    const raced = await db.query.recruiterOpportunities.findFirst({
      where: and(
        eq(recruiterOpportunities.userId, userId),
        eq(recruiterOpportunities.companyNormalized, normalized)
      ),
    });
    if (!raced) return null;
    return mergeIntoExisting(raced.id, raced, finding, at);
  }

  return mergeIntoExisting(existing.id, existing, finding, at);
}

async function mergeIntoExisting(
  id: string,
  existing: typeof recruiterOpportunities.$inferSelect,
  finding: ThreadFinding,
  at: Date
): Promise<{ id: string; created: boolean }> {
  const db = await getDb();

  const current: StageObservation = {
    stage: existing.stage as RecruiterStage,
    at: existing.stageUpdatedAt ?? existing.updatedAt,
  };
  const merged = mergeStage(current, { stage: finding.stage, at });
  const stageChanged = merged.stage !== existing.stage;

  await db
    .update(recruiterOpportunities)
    .set({
      stage: merged.stage,
      stageUpdatedAt: merged.at,
      // Evidence must describe the stage now shown, so it only moves when the stage does.
      stageEvidence: stageChanged ? finding.stageEvidence : existing.stageEvidence,
      roles: mergeRoles(existing.roles, finding.roles),
      // The newest word on where things stand wins; an older thread must not overwrite it.
      summary:
        !existing.lastActivityAt || at >= existing.lastActivityAt
          ? (finding.summary ?? existing.summary)
          : existing.summary,
      nextStep:
        !existing.lastActivityAt || at >= existing.lastActivityAt
          ? (finding.nextStep ?? existing.nextStep)
          : existing.nextStep,
      firstActivityAt:
        finding.firstMessageAt && (!existing.firstActivityAt || finding.firstMessageAt < existing.firstActivityAt)
          ? finding.firstMessageAt
          : existing.firstActivityAt,
      lastActivityAt:
        finding.lastMessageAt && (!existing.lastActivityAt || finding.lastMessageAt > existing.lastActivityAt)
          ? finding.lastMessageAt
          : existing.lastActivityAt,
      confidence: Math.max(existing.confidence, pct(finding.confidence)),
      updatedAt: new Date(),
    })
    .where(eq(recruiterOpportunities.id, id));

  return { id, created: false };
}

/** Recomputes `thread_count` from the threads themselves rather than incrementing a counter. */
async function refreshThreadCount(opportunityId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(recruiterOpportunities)
    .set({
      threadCount: sql`(SELECT count(*)::int FROM recruiter_threads WHERE opportunity_id = ${opportunityId})`,
      updatedAt: new Date(),
    })
    .where(eq(recruiterOpportunities.id, opportunityId));
}

/**
 * Writes one classified thread through to the recruiter tables.
 *
 * Idempotent by construction: opportunities are keyed on (user, company) and threads on
 * (user, gmail thread), so re-running a scan over mail it has already seen updates rows
 * instead of multiplying them.
 */
export async function applyThreadFinding(
  userId: string,
  finding: ThreadFinding
): Promise<{ opportunityId: string | null; recruiterId: string | null }> {
  const db = await getDb();

  const opportunity = await upsertOpportunity(userId, finding);

  // Only a human correspondent becomes a contact. Automated mail contributes its stage and
  // nothing else — there is nobody behind `no-reply@` to build a relationship with.
  let recruiterId: string | null = null;
  if (finding.senderKind === "human" && finding.correspondentEmail) {
    const recruiter = await upsertCanonicalRecruiter({
      fullName: finding.correspondentName || finding.correspondentEmail,
      firm: finding.recruiterFirm,
      email: finding.correspondentEmail,
      specialty: finding.roles,
    });
    recruiterId = recruiter.id;

    await ensureUserLink({
      userId,
      recruiterId,
      status: "contacted",
      source: "gmail",
    });

    await db
      .update(userRecruiterLinks)
      .set({
        aiSummary: finding.summary,
        companiesMentioned: finding.hiringCompany ? [finding.hiringCompany] : [],
        rolesDiscussed: finding.roles,
        gmailThreadId: finding.gmailThreadId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(userRecruiterLinks.userId, userId),
          eq(userRecruiterLinks.recruiterId, recruiterId)
        )
      );

    await recordVerdict(userId, finding.correspondentEmail, "recruiter", finding.confidence);
  }

  await db
    .insert(recruiterThreads)
    .values({
      userId,
      gmailThreadId: finding.gmailThreadId,
      opportunityId: opportunity?.id ?? null,
      recruiterId,
      direction: finding.direction,
      senderKind: finding.senderKind,
      subject: finding.subject,
      messageCount: finding.messageCount,
      userReplied: finding.userReplied ? 1 : 0,
      stageAtThread: finding.stage,
      firstMessageAt: finding.firstMessageAt,
      lastMessageAt: finding.lastMessageAt,
    })
    .onConflictDoUpdate({
      target: [recruiterThreads.userId, recruiterThreads.gmailThreadId],
      set: {
        opportunityId: opportunity?.id ?? null,
        recruiterId,
        direction: finding.direction,
        senderKind: finding.senderKind,
        subject: finding.subject,
        messageCount: finding.messageCount,
        userReplied: finding.userReplied ? 1 : 0,
        stageAtThread: finding.stage,
        firstMessageAt: finding.firstMessageAt,
        lastMessageAt: finding.lastMessageAt,
        updatedAt: new Date(),
      },
    });

  if (opportunity) await refreshThreadCount(opportunity.id);

  return { opportunityId: opportunity?.id ?? null, recruiterId };
}

/**
 * Remembers what the classifier decided about a sender.
 *
 * This is what makes a repeat scan nearly free, and what gives the review queue teeth: a
 * rejection here means the sender is never classified again at this prompt version.
 */
export async function recordVerdict(
  userId: string,
  email: string,
  verdict: "recruiter" | "not_recruiter",
  confidence = 0
): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return;

  const db = await getDb();
  const now = new Date();
  await db
    .insert(recruiterScanVerdicts)
    .values({
      userId,
      emailNormalized: normalized,
      verdict,
      confidence: pct(confidence),
      promptVersion: RECRUITER_PROMPT_VERSION,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: [recruiterScanVerdicts.userId, recruiterScanVerdicts.emailNormalized],
      set: {
        verdict,
        confidence: pct(confidence),
        promptVersion: RECRUITER_PROMPT_VERSION,
        lastSeenAt: now,
        updatedAt: now,
      },
    });
}

/** Verdicts for this user at the current prompt version, keyed by email. */
export async function loadVerdicts(
  userId: string
): Promise<Map<string, "recruiter" | "not_recruiter">> {
  const db = await getDb();
  const rows = await db.query.recruiterScanVerdicts.findMany({
    where: and(
      eq(recruiterScanVerdicts.userId, userId),
      eq(recruiterScanVerdicts.promptVersion, RECRUITER_PROMPT_VERSION)
    ),
  });
  return new Map(rows.map((r) => [r.emailNormalized, r.verdict]));
}

/**
 * Records a finding, applying it when confident enough and queueing it otherwise.
 *
 * A queued finding writes nothing but itself — the recruiter tables stay untouched until a
 * person approves it. An applied one is still recorded, so an automatic write remains
 * auditable rather than invisible.
 */
export async function recordFinding(
  userId: string,
  importId: string | null,
  finding: ThreadFinding,
  opts: { autoApply: boolean }
): Promise<RecruiterFindingStatus> {
  const db = await getDb();
  const status: RecruiterFindingStatus = opts.autoApply ? "auto_applied" : "pending";

  if (opts.autoApply) await applyThreadFinding(userId, finding);

  const now = new Date();
  await db
    .insert(recruiterScanFindings)
    .values({
      userId,
      importId,
      gmailThreadId: finding.gmailThreadId,
      payload: finding as unknown as Record<string, unknown>,
      confidence: pct(finding.confidence),
      status,
      appliedAt: opts.autoApply ? now : null,
    })
    .onConflictDoUpdate({
      target: [recruiterScanFindings.userId, recruiterScanFindings.gmailThreadId],
      set: {
        importId,
        payload: finding as unknown as Record<string, unknown>,
        confidence: pct(finding.confidence),
        status,
        appliedAt: opts.autoApply ? now : null,
        updatedAt: now,
      },
    });

  return status;
}
