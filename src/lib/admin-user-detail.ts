import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  aiSuggestions,
  calendarSubscriptions,
  chatMessages,
  chatThreads,
  companies,
  contactEmbeddings,
  contactTags,
  contacts,
  gmailConnections,
  imports,
  interactions,
  outlookConnections,
  outreachCampaigns,
  outreachMessages,
  outreachProspects,
  reminders,
  suggestedReminders,
  tags,
  usageEvents,
  userGoals,
  userRecruiterLinks,
  userSettings,
} from "@/db/schema";
import { entitlementsForPlan, resolvePlan } from "@/lib/entitlements";
import type { Entitlements, Plan, PlanSource } from "@/lib/entitlements";
import { assertRevealable } from "@/lib/admin-redaction";

/**
 * Read-only inspection of one account, for operator support.
 *
 * Contact records read plainly. This module used to mask them behind a time-boxed,
 * per-account grant that the operator had to request with a typed reason; that gate was
 * removed deliberately, because on a single-operator console it was friction paid by the
 * one person it was protecting against, on every support question. Opening an account
 * still writes an `account.view` row to `admin_audit_log` — the record of *what was
 * looked at* survives; only the ceremony is gone.
 *
 * WHAT IS STILL ABSOLUTE. Redaction lives in this query layer rather than in components,
 * and the part that matters never depended on the grant at all: a short list of columns is
 * never SELECTed here under any circumstance, so no component *can* render a value it was
 * never sent. That list is enforced at runtime by `assertRevealable()` against
 * `NEVER_REVEALABLE` in `src/lib/admin-redaction.ts`:
 *   - *_api_key_encrypted, twilio_auth_token_encrypted  (never decrypt a foreign user's key)
 *   - calendar_feed_token                               (a live plaintext bearer credential)
 *   - gmail/outlook access + refresh tokens             (same class)
 *   - chat_messages.content                             (the most private data in the app,
 *                                                        and no support question needs it)
 *
 * Those are credentials and private correspondence, not support context. Nothing about
 * answering "why did this user's import fail" needs them, so the denylist stays a hard
 * runtime assertion rather than a convention — add a column to the reads below that
 * collides with it and the query throws rather than quietly widening.
 *
 * Two tiers remain, but they are now about *cost*, not permission: `getAdminUserDetail`
 * returns a cheap summary row per contact, and `listAdminContacts` /
 * `getAdminContactDetail` populate the full `detail` object. A null `detail` means "this
 * read did not ask for it", never "you are not allowed to see it".
 */

export type AdminIdentity = {
  userId: string;
  email: string | null;
  /** Mirrored from Clerk; null on accounts that predate the mirror. */
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
  signupAt: Date;
  lastActiveAt: Date | null;
  onboardingCompletedAt: Date | null;
  onboardingStep: string | null;
  wizardCompletedAt: Date | null;
  theme: string | null;
  suspendedAt: Date | null;
  suspendedReason: string | null;
  suspendedBy: string | null;
};

export type AdminBilling = {
  plan: Plan;
  source: PlanSource;
  entitlements: Entitlements;
  compedPlan: "orbit" | "lifetime" | null;
  compedNote: string | null;
  compedAt: Date | null;
  compedBy: string | null;
  lifetimePurchasedAt: Date | null;
  subscriptionPlan: "orbit" | null;
  subscriptionStatus: "active" | "past_due" | "canceled" | null;
  subscriptionPeriodEnd: Date | null;
  stripeCustomerId: string | null;
};

/** Booleans only — the presence of a credential, never its value. */
export type AdminConfiguration = {
  aiProvider: string | null;
  aiModel: string | null;
  keys: {
    gemini: boolean;
    openai: boolean;
    anthropic: boolean;
    apollo: boolean;
    resend: boolean;
    twilio: boolean;
  };
  /** Whether a key exists for the provider the user actually selected. */
  hasSelectedProviderKey: boolean;
  calendarFeedEnabled: boolean;
  calendarFeedLastFetchedAt: Date | null;
  goalCount: number;
};

export type AdminFootprint = {
  contacts: number;
  companies: number;
  interactions: number;
  reminders: number;
  remindersPending: number;
  tags: number;
  chatThreads: number;
  chatMessages: number;
  imports: number;
  embeddings: number;
  suggestions: number;
  suggestedReminders: number;
  outreachCampaigns: number;
  outreachProspects: number;
  outreachMessagesSent: number;
  recruiterLinks: number;
  firstContactAt: Date | null;
  lastWriteAt: Date | null;
};

export type AdminHealthItem = {
  kind: "import" | "sync" | "ai" | "connection";
  severity: "error" | "warn";
  label: string;
  /** Verbatim system output — not user content, so it is shown in full. */
  detail: string | null;
  at: Date | null;
};

export type AdminUsageSummary = {
  totalCalls: number;
  failedCalls: number;
  onOrbitKey: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostMicros: number;
  byOperation: Array<{ operation: string; calls: number; failures: number }>;
  byModel: Array<{ provider: string; model: string; calls: number }>;
  recentErrors: Array<{ errorKind: string; model: string; at: Date | null }>;
};

export type AdminTimelineEntry = {
  kind: string;
  /** Structural label only — never a contact name or a message body. */
  label: string;
  at: Date;
};

export type AdminContactRow = {
  id: string;
  name: string;
  email: string | null;
  company: string | null;
  title: string | null;
  interactionCount: number;
  createdAt: Date;
  /**
   * The full record. Null on the summary read (`getAdminUserDetail`), which does not select
   * these columns because it does not render them — not because they are withheld.
   */
  detail: AdminContactFields | null;
};

export type AdminContactFields = {
  fullName: string;
  email: string | null;
  phone: string | null;
  location: string | null;
  school: string | null;
  linkedinUrl: string | null;
  notes: string | null;
  aiSummary: string | null;
  metContext: string | null;
  howMet: string | null;
  keyFacts: string[];
  opportunities: string[];
};

function num(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function maxDate(...values: Array<Date | string | null | undefined>): Date | null {
  let best: Date | null = null;
  for (const raw of values) {
    const d = toDate(raw);
    if (!d) continue;
    if (!best || d.getTime() > best.getTime()) best = d;
  }
  return best;
}

const countInt = sql<number>`count(*)::int`;

export type AdminUserDetail = {
  identity: AdminIdentity;
  billing: AdminBilling;
  configuration: AdminConfiguration;
  footprint: AdminFootprint;
  health: AdminHealthItem[];
  usage: AdminUsageSummary;
  timeline: AdminTimelineEntry[];
  contacts: AdminContactRow[];
  contactTotal: number;
};

export async function getAdminUserDetail(
  userId: string
): Promise<AdminUserDetail | null> {
  const db = await getDb();

  const settings = await db.query.userSettings.findFirst({
    where: eq(userSettings.userId, userId),
  });
  if (!settings) return null;

  const [
    contactAgg,
    companyAgg,
    interactionAgg,
    reminderAgg,
    tagAgg,
    threadAgg,
    messageAgg,
    embeddingAgg,
    suggestionAgg,
    goalAgg,
    importRows,
    calendarRows,
    gmailRow,
    outlookRow,
    usageAgg,
    usageByOperation,
    usageByModel,
    usageErrors,
    contactRows,
  ] = await Promise.all([
    db
      .select({
        n: countInt,
        firstAt: sql<string | null>`min(${contacts.createdAt})`,
        lastAt: sql<string | null>`max(${contacts.createdAt})`,
      })
      .from(contacts)
      .where(eq(contacts.userId, userId)),

    db.select({ n: countInt }).from(companies).where(eq(companies.userId, userId)),

    db
      .select({
        n: countInt,
        lastAt: sql<string | null>`max(${interactions.createdAt})`,
      })
      .from(interactions)
      .where(eq(interactions.userId, userId)),

    db.select({ n: countInt }).from(reminders).where(eq(reminders.userId, userId)),
    db.select({ n: countInt }).from(tags).where(eq(tags.userId, userId)),
    db.select({ n: countInt }).from(chatThreads).where(eq(chatThreads.userId, userId)),

    db
      .select({
        n: countInt,
        lastAt: sql<string | null>`max(${chatMessages.createdAt})`,
      })
      .from(chatMessages)
      .where(eq(chatMessages.userId, userId)),

    db
      .select({ n: countInt })
      .from(contactEmbeddings)
      .where(eq(contactEmbeddings.userId, userId)),

    db
      .select({ n: countInt })
      .from(aiSuggestions)
      .where(eq(aiSuggestions.userId, userId)),

    db.select({ n: countInt }).from(userGoals).where(eq(userGoals.userId, userId)),

    // Import metadata and error strings are system output, so they are shown verbatim.
    db.query.imports.findMany({
      where: eq(imports.userId, userId),
      orderBy: [desc(imports.createdAt)],
      limit: 25,
      columns: {
        id: true,
        importType: true,
        fileName: true,
        status: true,
        totalRows: true,
        rowsProcessed: true,
        contactsCreated: true,
        errorMessage: true,
        createdAt: true,
        updatedAt: true,
      },
    }),

    db.query.calendarSubscriptions.findMany({
      where: eq(calendarSubscriptions.userId, userId),
      columns: {
        id: true,
        label: true,
        enabled: true,
        lastSyncedAt: true,
        lastSyncStatus: true,
        lastSyncError: true,
      },
    }),

    // Connection status and timestamps only — never the tokens.
    db.query.gmailConnections.findFirst({
      where: eq(gmailConnections.userId, userId),
      columns: {
        emailAddress: true,
        status: true,
        lastSyncedAt: true,
        tokenExpiresAt: true,
        updatedAt: true,
      },
    }),

    db.query.outlookConnections.findFirst({
      where: eq(outlookConnections.userId, userId),
      columns: {
        emailAddress: true,
        status: true,
        lastSyncedAt: true,
        tokenExpiresAt: true,
        updatedAt: true,
      },
    }),

    db
      .select({
        n: countInt,
        failures: sql<string>`coalesce(sum(case when ${usageEvents.success} = 0 then 1 else 0 end), 0)`,
        orbitKey: sql<string>`coalesce(sum(case when ${usageEvents.keyOwner} = 'orbit' then 1 else 0 end), 0)`,
        inTok: sql<string>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
        outTok: sql<string>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
        cost: sql<string>`coalesce(sum(${usageEvents.estimatedCostMicros}), 0)`,
        lastAt: sql<string | null>`max(${usageEvents.createdAt})`,
      })
      .from(usageEvents)
      .where(eq(usageEvents.userId, userId)),

    db
      .select({
        operation: usageEvents.operation,
        calls: countInt,
        failures: sql<string>`coalesce(sum(case when ${usageEvents.success} = 0 then 1 else 0 end), 0)`,
      })
      .from(usageEvents)
      .where(eq(usageEvents.userId, userId))
      .groupBy(usageEvents.operation),

    db
      .select({
        provider: usageEvents.provider,
        model: usageEvents.model,
        calls: countInt,
      })
      .from(usageEvents)
      .where(eq(usageEvents.userId, userId))
      .groupBy(usageEvents.provider, usageEvents.model),

    db
      .select({
        errorKind: usageEvents.errorKind,
        model: usageEvents.model,
        createdAt: usageEvents.createdAt,
      })
      .from(usageEvents)
      .where(and(eq(usageEvents.userId, userId), eq(usageEvents.success, 0)))
      .orderBy(desc(usageEvents.createdAt))
      .limit(10),

    // The summary read — identity and affiliation, no notes, summaries, key facts or
    // opportunities. Those live behind `getAdminContactDetail`, one contact at a time,
    // because a page listing twenty contacts has nowhere useful to put them.
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      orderBy: [desc(contacts.createdAt)],
      limit: 20,
      columns: CONTACT_BASE_COLUMNS,
    }),
  ]);

  const { plan, source } = resolvePlan(settings);
  // Mirrors the union in `getEntitlements`: a Lifetime holder who also subscribes keeps
  // hosted enrichment while that subscription is live.
  const hostedEnrichment =
    plan === "orbit" ||
    (settings.subscriptionPlan === "orbit" &&
      (settings.subscriptionStatus === "active" ||
        (settings.subscriptionPeriodEnd?.getTime() ?? 0) > Date.now()));

  const provider = settings.aiProvider ?? "gemini";
  const keys = {
    gemini: Boolean(settings.geminiApiKeyEncrypted),
    openai: Boolean(settings.openaiApiKeyEncrypted),
    anthropic: Boolean(settings.anthropicApiKeyEncrypted),
    apollo: Boolean(settings.apolloApiKeyEncrypted),
    resend: Boolean(settings.resendApiKeyEncrypted),
    twilio: Boolean(settings.twilioAuthTokenEncrypted),
  };

  // Interaction counts for the visible contact page only.
  //
  // The `inArray` is load-bearing: without it this grouped over every interaction the user
  // had and then looked up twenty of them, so decorating one page cost a full scan of the
  // largest table on a heavy account.
  const visibleIds = contactRows.map((c) => c.id);
  const interactionCounts = visibleIds.length
    ? await db
        .select({ contactId: interactions.contactId, n: countInt })
        .from(interactions)
        .where(
          and(
            eq(interactions.userId, userId),
            inArray(interactions.contactId, visibleIds)
          )
        )
        .groupBy(interactions.contactId)
    : [];
  const interactionsByContact = new Map(
    interactionCounts.map((r) => [r.contactId, r.n])
  );

  /**
   * The rest of the footprint, as scalar subqueries in one statement.
   *
   * Deliberately not eight more entries in the `Promise.all` above: on Neon HTTP every
   * entry is its own round trip, and this page already makes nineteen. One statement that
   * the planner runs as eight index lookups is the same work with a tenth of the latency.
   */
  const [extra] = await db
    .select({
      remindersPending: sql<number>`(
        SELECT count(*)::int FROM ${reminders}
        WHERE ${reminders.userId} = ${userId} AND ${reminders.status} = 'pending')`,
      suggestedReminders: sql<number>`(
        SELECT count(*)::int FROM ${suggestedReminders}
        WHERE ${suggestedReminders.userId} = ${userId})`,
      outreachCampaigns: sql<number>`(
        SELECT count(*)::int FROM ${outreachCampaigns}
        WHERE ${outreachCampaigns.userId} = ${userId})`,
      outreachProspects: sql<number>`(
        SELECT count(*)::int FROM ${outreachProspects} p
        JOIN ${outreachCampaigns} c ON c.id = p.campaign_id
        WHERE c.user_id = ${userId})`,
      outreachMessagesSent: sql<number>`(
        SELECT count(*)::int FROM ${outreachMessages} m
        JOIN ${outreachProspects} p ON p.id = m.prospect_id
        JOIN ${outreachCampaigns} c ON c.id = p.campaign_id
        WHERE c.user_id = ${userId} AND m.status = 'sent')`,
      recruiterLinks: sql<number>`(
        SELECT count(*)::int FROM ${userRecruiterLinks}
        WHERE ${userRecruiterLinks.userId} = ${userId})`,
    })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));

  const health: AdminHealthItem[] = [];

  for (const job of importRows) {
    if (job.status === "failed") {
      health.push({
        kind: "import",
        severity: "error",
        label: `Import failed: ${job.fileName ?? job.importType}`,
        detail: job.errorMessage,
        at: job.updatedAt,
      });
    } else if (
      job.status === "processing" &&
      Date.now() - job.updatedAt.getTime() > 10 * 60 * 1000
    ) {
      health.push({
        kind: "import",
        severity: "warn",
        label: `Import stalled at ${job.rowsProcessed ?? 0}/${job.totalRows ?? "?"} rows`,
        detail: job.fileName ?? job.importType,
        at: job.updatedAt,
      });
    }
  }

  for (const sub of calendarRows) {
    if (sub.lastSyncStatus === "error") {
      health.push({
        kind: "sync",
        severity: "error",
        label: `Calendar sync failing: ${sub.label ?? "feed"}`,
        detail: sub.lastSyncError,
        at: sub.lastSyncedAt,
      });
    }
  }

  for (const [name, conn] of [
    ["Gmail", gmailRow],
    ["Outlook", outlookRow],
  ] as const) {
    if (!conn) continue;
    if (conn.status && conn.status !== "active") {
      health.push({
        kind: "connection",
        severity: "error",
        label: `${name} connection is ${conn.status}`,
        detail: conn.emailAddress,
        at: conn.updatedAt,
      });
    } else if (conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() < Date.now()) {
      health.push({
        kind: "connection",
        severity: "warn",
        label: `${name} token expired`,
        detail: conn.emailAddress,
        at: conn.tokenExpiresAt,
      });
    }
  }

  const hasSelectedProviderKey =
    provider === "openai"
      ? keys.openai
      : provider === "anthropic"
        ? keys.anthropic
        : keys.gemini;

  if (!hasSelectedProviderKey) {
    health.push({
      kind: "ai",
      severity: "error",
      label: `No ${provider} API key configured`,
      detail:
        "Production is BYOK — every AI feature fails for this account until they add a key in Settings.",
      at: null,
    });
  }

  const usage = usageAgg[0];

  // Structural labels only. Never a contact name, never a message body.
  const timeline: AdminTimelineEntry[] = [
    ...importRows.map((job) => ({
      kind: "import",
      label: `Import ${job.status}: ${job.importType}${
        job.totalRows ? ` (${job.totalRows} rows)` : ""
      }`,
      at: job.createdAt,
    })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 30);

  return {
    identity: {
      userId: settings.userId,
      email: settings.email,
      firstName: settings.firstName,
      lastName: settings.lastName,
      imageUrl: settings.profileImageUrl,
      signupAt: settings.createdAt,
      lastActiveAt: settings.lastActiveAt,
      onboardingCompletedAt: settings.onboardingCompletedAt,
      onboardingStep: settings.onboardingStep,
      wizardCompletedAt: settings.wizardCompletedAt,
      theme: settings.theme,
      suspendedAt: settings.suspendedAt,
      suspendedReason: settings.suspendedReason,
      suspendedBy: settings.suspendedBy,
    },
    billing: {
      plan,
      source,
      entitlements: entitlementsForPlan(plan, source, { hostedEnrichment }),
      compedPlan: settings.compedPlan ?? null,
      compedNote: settings.compedNote,
      compedAt: settings.compedAt,
      compedBy: settings.compedBy,
      lifetimePurchasedAt: settings.lifetimePurchasedAt,
      subscriptionPlan: settings.subscriptionPlan ?? null,
      subscriptionStatus: settings.subscriptionStatus ?? null,
      subscriptionPeriodEnd: settings.subscriptionPeriodEnd,
      stripeCustomerId: settings.stripeCustomerId,
    },
    configuration: {
      aiProvider: settings.aiProvider,
      aiModel: settings.aiModel,
      keys,
      hasSelectedProviderKey,
      calendarFeedEnabled: Boolean(settings.calendarFeedToken),
      calendarFeedLastFetchedAt: settings.calendarFeedLastFetchedAt,
      goalCount: goalAgg[0]?.n ?? 0,
    },
    footprint: {
      contacts: contactAgg[0]?.n ?? 0,
      companies: companyAgg[0]?.n ?? 0,
      interactions: interactionAgg[0]?.n ?? 0,
      reminders: reminderAgg[0]?.n ?? 0,
      remindersPending: extra?.remindersPending ?? 0,
      tags: tagAgg[0]?.n ?? 0,
      chatThreads: threadAgg[0]?.n ?? 0,
      chatMessages: messageAgg[0]?.n ?? 0,
      imports: importRows.length,
      embeddings: embeddingAgg[0]?.n ?? 0,
      suggestions: suggestionAgg[0]?.n ?? 0,
      suggestedReminders: extra?.suggestedReminders ?? 0,
      outreachCampaigns: extra?.outreachCampaigns ?? 0,
      outreachProspects: extra?.outreachProspects ?? 0,
      outreachMessagesSent: extra?.outreachMessagesSent ?? 0,
      recruiterLinks: extra?.recruiterLinks ?? 0,
      firstContactAt: toDate(contactAgg[0]?.firstAt),
      lastWriteAt: maxDate(
        contactAgg[0]?.lastAt,
        interactionAgg[0]?.lastAt,
        messageAgg[0]?.lastAt,
        usage?.lastAt
      ),
    },
    health,
    usage: {
      totalCalls: usage?.n ?? 0,
      failedCalls: num(usage?.failures),
      onOrbitKey: num(usage?.orbitKey),
      inputTokens: num(usage?.inTok),
      outputTokens: num(usage?.outTok),
      estimatedCostMicros: num(usage?.cost),
      byOperation: usageByOperation
        .map((r) => ({
          operation: r.operation,
          calls: r.calls,
          failures: num(r.failures),
        }))
        .sort((a, b) => b.calls - a.calls),
      byModel: usageByModel.sort((a, b) => b.calls - a.calls),
      recentErrors: usageErrors.map((r) => ({
        errorKind: r.errorKind ?? "other",
        model: r.model,
        at: r.createdAt,
      })),
    },
    timeline,
    // `detail: null` here reflects the narrower query above, not a permission — the full
    // record is one click away at `/admin/users/[userId]/contacts/[contactId]`.
    contacts: contactRows.map((c) =>
      toContactRow(c as ContactRecord, interactionsByContact.get(c.id) ?? 0, false)
    ),
    contactTotal: contactAgg[0]?.n ?? 0,
  };
}

/* ------------------------------------------------------------------------------------
 * Two-tier contact reads
 *
 * The summary and detail paths differ by exactly one thing: which columns reach the
 * `columns:` object below. Everything downstream is shared, so the two cannot drift in
 * behaviour — only in how much they fetch.
 * --------------------------------------------------------------------------------- */

/** The summary read: enough to list contacts and link into them. */
const CONTACT_BASE_COLUMNS = {
  id: true,
  fullName: true,
  email: true,
  company: true,
  title: true,
  createdAt: true,
} as const;

/**
 * Added by the detail reads. Still checked against `NEVER_REVEALABLE` at runtime — this
 * object is the allowlist, and `CONTACT_SENSITIVE_QUALIFIED` below is its mirror in the
 * form the denylist check speaks.
 */
const CONTACT_SENSITIVE_COLUMNS = {
  phone: true,
  location: true,
  school: true,
  linkedinUrl: true,
  notes: true,
  aiSummary: true,
  metContext: true,
  howMet: true,
  keyFacts: true,
  opportunities: true,
} as const;

/**
 * Qualified names for the runtime denylist check. Kept adjacent to the column object above
 * so adding a field to one without the other is visible in a two-line diff.
 */
const CONTACT_SENSITIVE_QUALIFIED = [
  "contacts.phone",
  "contacts.location",
  "contacts.school",
  "contacts.linkedin_url",
  "contacts.notes",
  "contacts.ai_summary",
  "contacts.met_context",
  "contacts.how_met",
  "contacts.key_facts",
  "contacts.opportunities",
];

type ContactRecord = {
  id: string;
  fullName: string;
  email: string | null;
  company: string | null;
  title: string | null;
  createdAt: Date;
  phone?: string | null;
  location?: string | null;
  school?: string | null;
  linkedinUrl?: string | null;
  notes?: string | null;
  aiSummary?: string | null;
  metContext?: string | null;
  howMet?: string | null;
  keyFacts?: string[] | null;
  opportunities?: string[] | null;
};

/**
 * `withDetail` reflects which column set the caller queried, not whether it is permitted to
 * look. Passing `true` after a base-columns query would produce a row of nulls, so the two
 * are set together at each call site.
 */
function toContactRow(
  record: ContactRecord,
  interactionCount: number,
  withDetail: boolean
): AdminContactRow {
  return {
    id: record.id,
    name: record.fullName,
    email: record.email,
    company: record.company,
    title: record.title,
    interactionCount,
    createdAt: record.createdAt,
    detail: withDetail
      ? {
          fullName: record.fullName,
          email: record.email ?? null,
          phone: record.phone ?? null,
          location: record.location ?? null,
          school: record.school ?? null,
          linkedinUrl: record.linkedinUrl ?? null,
          notes: record.notes ?? null,
          aiSummary: record.aiSummary ?? null,
          metContext: record.metContext ?? null,
          howMet: record.howMet ?? null,
          keyFacts: record.keyFacts ?? [],
          opportunities: record.opportunities ?? [],
        }
      : null,
  };
}

export const ADMIN_CONTACTS_PAGE_SIZE = 25;

/**
 * One page of an account's contacts, in full.
 *
 * The interaction counts are restricted to the visible page with `inArray`. The inspector
 * previously grouped over *every* interaction the user had and then looked up twenty of
 * them — a full scan to decorate one page, which on a heavy account is the most expensive
 * query on the screen.
 */
export async function listAdminContacts(
  userId: string,
  opts: {
    page?: number;
    pageSize?: number;
  } = {}
): Promise<{ rows: AdminContactRow[]; total: number; page: number; pageSize: number }> {
  const db = await getDb();
  const pageSize = Math.min(Math.max(opts.pageSize ?? ADMIN_CONTACTS_PAGE_SIZE, 1), 200);
  const page = Math.max(opts.page ?? 1, 1);

  // Still asserted, with no gate left to hide behind: this is the check that fails loudly
  // if a credential column is ever added to `CONTACT_SENSITIVE_COLUMNS` by mistake.
  assertRevealable(CONTACT_SENSITIVE_QUALIFIED);

  const columns = { ...CONTACT_BASE_COLUMNS, ...CONTACT_SENSITIVE_COLUMNS };

  const [records, totalAgg] = await Promise.all([
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      orderBy: [desc(contacts.createdAt)],
      limit: pageSize,
      offset: (page - 1) * pageSize,
      columns,
    }),
    db.select({ n: countInt }).from(contacts).where(eq(contacts.userId, userId)),
  ]);

  const visibleIds = records.map((c) => c.id);
  const counts = visibleIds.length
    ? await db
        .select({ contactId: interactions.contactId, n: countInt })
        .from(interactions)
        .where(
          and(
            eq(interactions.userId, userId),
            inArray(interactions.contactId, visibleIds)
          )
        )
        .groupBy(interactions.contactId)
    : [];
  const byContact = new Map(counts.map((r) => [r.contactId, r.n]));

  return {
    rows: records.map((r) =>
      toContactRow(r as ContactRecord, byContact.get(r.id) ?? 0, true)
    ),
    total: totalAgg[0]?.n ?? 0,
    page,
    pageSize,
  };
}

export type AdminInteractionRow = {
  id: string;
  interactionType: string;
  source: string | null;
  interactionDate: Date;
  createdAt: Date;
  /**
   * Counted across *all* of the contact's interactions, not just the fifty in `detail`.
   * "notes on 12 of 14" is the fastest answer to "did the capture actually write anything".
   */
  hasRawNotes: boolean;
  hasAiSummary: boolean;
  topicCount: number;
  detail: InteractionFields;
};

export type InteractionFields = {
  rawNotes: string | null;
  aiSummary: string | null;
  topics: string[];
  actionItems: string[];
  sentiment: string | null;
};

export type AdminContactDetail = {
  contact: AdminContactRow;
  userId: string;
  relationshipScore: number | null;
  statedCloseness: number | null;
  priorityLevel: number | null;
  source: string | null;
  industry: string | null;
  firstInteractionAt: Date | null;
  lastInteractionAt: Date | null;
  nextFollowUpAt: Date | null;
  followUpStatus: string | null;
  updatedAt: Date;
  interactions: AdminInteractionRow[];
  reminderCount: number;
  tagCount: number;
  embeddingCount: number;
};

const INTERACTION_BASE_COLUMNS = {
  id: true,
  interactionType: true,
  source: true,
  interactionDate: true,
  createdAt: true,
} as const;

const INTERACTION_SENSITIVE_COLUMNS = {
  rawNotes: true,
  aiSummary: true,
  topics: true,
  actionItems: true,
  sentiment: true,
} as const;

const INTERACTION_SENSITIVE_QUALIFIED = [
  "interactions.raw_notes",
  "interactions.ai_summary",
  "interactions.topics",
  "interactions.action_items",
  "interactions.sentiment",
];

/**
 * One contact record and its interactions.
 *
 * Presence booleans (`hasRawNotes`, `topicCount`) survived the removal of the reveal gate
 * because they were never really about redaction: "this contact has notes on 12 of 14
 * interactions" is the answer to *did the capture actually write anything*, and reading it
 * off a count is faster and clearer than eyeballing fifty rows of prose for blanks.
 *
 * They come from SQL predicates rather than from the returned rows so the count covers
 * every interaction, not just the fifty most recent ones fetched below.
 */
export async function getAdminContactDetail(
  userId: string,
  contactId: string
): Promise<AdminContactDetail | null> {
  const db = await getDb();

  assertRevealable([
    ...CONTACT_SENSITIVE_QUALIFIED,
    ...INTERACTION_SENSITIVE_QUALIFIED,
  ]);

  const record = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: {
      ...CONTACT_BASE_COLUMNS,
      ...CONTACT_SENSITIVE_COLUMNS,
      relationshipScore: true,
      statedCloseness: true,
      priorityLevel: true,
      source: true,
      industry: true,
      firstInteractionAt: true,
      lastInteractionAt: true,
      nextFollowUpAt: true,
      followUpStatus: true,
      updatedAt: true,
    },
  });
  if (!record) return null;

  const [interactionRows, presence, reminderAgg, tagAgg, embeddingAgg] =
    await Promise.all([
      db.query.interactions.findMany({
        where: and(
          eq(interactions.userId, userId),
          eq(interactions.contactId, contactId)
        ),
        orderBy: [desc(interactions.interactionDate)],
        limit: 50,
        columns: { ...INTERACTION_BASE_COLUMNS, ...INTERACTION_SENSITIVE_COLUMNS },
      }),

      // Counted across every interaction, not just the fifty fetched above.
      db
        .select({
          id: interactions.id,
          hasRawNotes: sql<boolean>`${interactions.rawNotes} is not null`,
          hasAiSummary: sql<boolean>`${interactions.aiSummary} is not null`,
          topicCount: sql<number>`coalesce(jsonb_array_length(${interactions.topics}), 0)::int`,
        })
        .from(interactions)
        .where(
          and(
            eq(interactions.userId, userId),
            eq(interactions.contactId, contactId)
          )
        ),

      db
        .select({ n: countInt })
        .from(reminders)
        .where(
          and(eq(reminders.userId, userId), eq(reminders.contactId, contactId))
        ),

      db
        .select({ n: countInt })
        .from(contactTags)
        .where(eq(contactTags.contactId, contactId)),

      db
        .select({ n: countInt })
        .from(contactEmbeddings)
        .where(
          and(
            eq(contactEmbeddings.userId, userId),
            eq(contactEmbeddings.contactId, contactId)
          )
        ),
    ]);

  const presenceById = new Map(presence.map((p) => [p.id, p]));

  return {
    contact: toContactRow(record as ContactRecord, presence.length, true),
    userId,
    relationshipScore: record.relationshipScore ?? null,
    statedCloseness: record.statedCloseness ?? null,
    priorityLevel: record.priorityLevel ?? null,
    source: record.source ?? null,
    industry: record.industry ?? null,
    firstInteractionAt: record.firstInteractionAt ?? null,
    lastInteractionAt: record.lastInteractionAt ?? null,
    nextFollowUpAt: record.nextFollowUpAt ?? null,
    followUpStatus: record.followUpStatus ?? null,
    updatedAt: record.updatedAt,
    interactions: interactionRows.map((row): AdminInteractionRow => {
      const p = presenceById.get(row.id);
      const r = row as typeof row & Partial<InteractionFields>;
      return {
        id: row.id,
        interactionType: row.interactionType,
        source: row.source,
        interactionDate: row.interactionDate,
        createdAt: row.createdAt,
        hasRawNotes: Boolean(p?.hasRawNotes),
        hasAiSummary: Boolean(p?.hasAiSummary),
        topicCount: p?.topicCount ?? 0,
        detail: {
          rawNotes: r.rawNotes ?? null,
          aiSummary: r.aiSummary ?? null,
          topics: r.topics ?? [],
          actionItems: r.actionItems ?? [],
          sentiment: r.sentiment ?? null,
        },
      };
    }),
    reminderCount: reminderAgg[0]?.n ?? 0,
    tagCount: tagAgg[0]?.n ?? 0,
    embeddingCount: embeddingAgg[0]?.n ?? 0,
  };
}
