import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  aiSuggestions,
  calendarSubscriptions,
  chatMessages,
  chatThreads,
  companies,
  contactEmbeddings,
  contacts,
  gmailConnections,
  imports,
  interactions,
  outlookConnections,
  reminders,
  tags,
  usageEvents,
  userGoals,
  userSettings,
} from "@/db/schema";
import { entitlementsForPlan, resolvePlan } from "@/lib/entitlements";
import type { Entitlements, Plan, PlanSource } from "@/lib/entitlements";

/**
 * Read-only inspection of one account, for operator support.
 *
 * THE RULE THIS MODULE ENFORCES: the inspector shows system state and metadata. It never
 * shows prose a user wrote about another human being.
 *
 * Orbit's data is not primarily about its users — it is about third parties who never
 * signed up for anything and have no way to object. So contact names are masked here, and
 * notes, AI summaries, key facts and chat transcripts are never selected at all. Redaction
 * lives in this query layer rather than in components on purpose: it makes the allowlist
 * greppable and auditable, and it means no component *can* leak a field it never receives.
 *
 * Never selected, under any circumstance:
 *   - *_api_key_encrypted, twilio_auth_token_encrypted  (never decrypt a foreign user's key)
 *   - calendar_feed_token                               (a live plaintext bearer credential)
 *   - gmail/outlook access + refresh tokens             (same class)
 *   - chat_messages.content                             (the most private data in the app)
 *   - contacts.notes / key_facts / opportunities / ai_summary / met_context / how_met
 *   - contacts.email / phone                            (third-party PII)
 *   - interactions.raw_notes / ai_summary / topics
 */

/** Masks a name to a length hint: enough to spot duplicates, not enough to identify. */
export function maskName(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "—";
  return `${"▨".repeat(Math.min(trimmed.length, 12))} (${trimmed.length})`;
}

export type AdminIdentity = {
  userId: string;
  email: string | null;
  signupAt: Date;
  lastActiveAt: Date | null;
  onboardingCompletedAt: Date | null;
  onboardingStep: string | null;
  wizardCompletedAt: Date | null;
  theme: string | null;
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
  tags: number;
  chatThreads: number;
  chatMessages: number;
  imports: number;
  embeddings: number;
  suggestions: number;
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
  maskedName: string;
  company: string | null;
  title: string | null;
  interactionCount: number;
  createdAt: Date;
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

    // Column allowlist: no email, phone, notes, summaries, key facts or opportunities.
    db.query.contacts.findMany({
      where: eq(contacts.userId, userId),
      orderBy: [desc(contacts.createdAt)],
      limit: 20,
      columns: {
        id: true,
        fullName: true,
        company: true,
        title: true,
        createdAt: true,
      },
    }),
  ]);

  const { plan, source } = resolvePlan(settings);
  const hostedSends =
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

  // Interaction counts for the visible contact page only — avoids a full per-contact scan.
  const visibleIds = contactRows.map((c) => c.id);
  const interactionCounts = visibleIds.length
    ? await db
        .select({ contactId: interactions.contactId, n: countInt })
        .from(interactions)
        .where(eq(interactions.userId, userId))
        .groupBy(interactions.contactId)
    : [];
  const interactionsByContact = new Map(
    interactionCounts.map((r) => [r.contactId, r.n])
  );

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
      signupAt: settings.createdAt,
      lastActiveAt: settings.lastActiveAt,
      onboardingCompletedAt: settings.onboardingCompletedAt,
      onboardingStep: settings.onboardingStep,
      wizardCompletedAt: settings.wizardCompletedAt,
      theme: settings.theme,
    },
    billing: {
      plan,
      source,
      entitlements: entitlementsForPlan(plan, source, { hostedSends }),
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
      tags: tagAgg[0]?.n ?? 0,
      chatThreads: threadAgg[0]?.n ?? 0,
      chatMessages: messageAgg[0]?.n ?? 0,
      imports: importRows.length,
      embeddings: embeddingAgg[0]?.n ?? 0,
      suggestions: suggestionAgg[0]?.n ?? 0,
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
    contacts: contactRows.map((c) => ({
      id: c.id,
      maskedName: maskName(c.fullName),
      company: c.company,
      title: c.title,
      interactionCount: interactionsByContact.get(c.id) ?? 0,
      createdAt: c.createdAt,
    })),
    contactTotal: contactAgg[0]?.n ?? 0,
  };
}
