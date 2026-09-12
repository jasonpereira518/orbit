import { NextResponse, type NextRequest } from "next/server";
import Papa from "papaparse";
import { AdminForbiddenError, requireAdminUserId } from "@/lib/admin";
import { recordAdminAction } from "@/lib/admin-operations";
import {
  loadAdminRosterAll,
  type RosterPlanFilter,
  type RosterSort,
  type RosterStateFilter,
} from "@/lib/admin-roster";
import { getAdminHealth } from "@/lib/admin-health";
import {
  isInterestListFilter,
  loadInterestListAll,
  sourceLabel,
} from "@/lib/admin-interest-list";
import { isFeedbackFilter, loadFeedbackAll } from "@/lib/admin-feedback";
import { loadAuditLog } from "@/lib/admin-operations";
import { formatCostMicros } from "@/lib/ai-pricing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * CSV/JSON export of the roster, health list and audit log.
 *
 * A route handler rather than a server action, because an action cannot set
 * `Content-Disposition` and so cannot hand the browser a file.
 *
 * IT GATES ITSELF. `(admin)/layout.tsx` does not run for route handlers, any more than it
 * runs for Server Action POSTs — this file is reachable by a plain GET, so the first thing
 * it does is `requireAdminUserId()`. `AdminForbiddenError` becomes a 404 with the same body
 * `(admin)/not-found.tsx` would render: a 403 confirms the endpoint exists and gates by
 * role, which on a console with exactly one legitimate user is pure information leak.
 *
 * NO THIRD-PARTY PII LEAVES THROUGH HERE, ever, and the export path is deliberately
 * grant-blind: `loadAdminRosterAll` reads account-level columns only, and no dataset touches
 * `contacts`. A reveal grant is a licence to look at one account for fifteen minutes, not to
 * extract a spreadsheet of other people's phone numbers that outlives it.
 */

const DATASETS = ["roster", "health", "audit", "interest-list", "feedback"] as const;
type Dataset = (typeof DATASETS)[number];

function isDataset(value: string | null): value is Dataset {
  return value != null && (DATASETS as readonly string[]).includes(value);
}

function iso(date: Date | null | undefined): string {
  return date ? date.toISOString() : "";
}

export async function GET(request: NextRequest) {
  let adminUserId: string;
  try {
    adminUserId = await requireAdminUserId();
  } catch (err) {
    if (err instanceof AdminForbiddenError) {
      return new NextResponse("Not found", { status: 404 });
    }
    // Anything else is a genuine fault, not an authorisation answer — but it still must not
    // describe this endpoint to an unauthenticated caller.
    return new NextResponse("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const datasetParam = url.searchParams.get("dataset");
  const dataset: Dataset = isDataset(datasetParam) ? datasetParam : "roster";
  const format = url.searchParams.get("format") === "json" ? "json" : "csv";

  const interestFilter = url.searchParams.get("filter") ?? undefined;

  const filters = {
    q: url.searchParams.get("q") ?? undefined,
    plan: (url.searchParams.get("plan") ?? "all") as RosterPlanFilter,
    state: (url.searchParams.get("state") ?? "all") as RosterStateFilter,
    sort: (url.searchParams.get("sort") ?? "signup") as RosterSort,
  };

  const { rows, count } = await buildDataset(dataset, filters, interestFilter);

  await recordAdminAction({
    adminUserId,
    action: "export.download",
    detail: { dataset, format, rows: count, ...filters },
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `orbit-${dataset}-${stamp}.${format}`;
  const body =
    format === "json" ? JSON.stringify(rows, null, 2) : Papa.unparse(rows);

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type":
        format === "json"
          ? "application/json; charset=utf-8"
          : "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Never let a proxy or the browser keep a copy of an account list.
      "Cache-Control": "private, no-store",
    },
  });
}

async function buildDataset(
  dataset: Dataset,
  filters: {
    q?: string;
    plan: RosterPlanFilter;
    state: RosterStateFilter;
    sort: RosterSort;
  },
  interestFilter?: string
): Promise<{ rows: Array<Record<string, unknown>>; count: number }> {
  if (dataset === "interest-list") {
    // First-party only: these addresses were typed into Orbit's own form by their owners,
    // which is what separates this from the contact data this route refuses to emit.
    const signups = await loadInterestListAll(
      isInterestListFilter(interestFilter) ? interestFilter : "all"
    );
    const rows = signups.map((r) => ({
      email: r.email,
      signed_up_at: iso(r.createdAt),
      status: r.unsubscribedAt ? "unsubscribed" : r.converted ? "converted" : "active",
      unsubscribed_at: iso(r.unsubscribedAt),
      converted: r.converted,
      follow_up_sent_at: iso(r.followUpSentAt),
      source: sourceLabel(r),
      referrer: r.referrer ?? "",
      utm_source: r.utmSource ?? "",
      utm_medium: r.utmMedium ?? "",
      utm_campaign: r.utmCampaign ?? "",
      landing_path: r.landingPath ?? "",
      welcome_planet: r.welcomePlanet ?? "",
    }));
    return { rows, count: rows.length };
  }

  if (dataset === "feedback") {
    // First-party by construction: this table is a user writing about Orbit, not about a
    // third party — the distinction the `feedback` table's doc comment turns on. The
    // screenshots are deliberately absent; `inline_data` must never reach a CSV.
    const entries = await loadFeedbackAll(
      isFeedbackFilter(interestFilter) ? interestFilter : "all"
    );
    const rows = entries.map((r) => ({
      id: r.id,
      created_at: iso(r.createdAt),
      email: r.submitterEmail ?? "",
      kind: r.kind,
      category: r.category ?? "",
      area: r.area ?? "",
      status: r.status,
      score: r.score ?? "",
      text: r.text ?? "",
      screenshots: r.screenshotCount,
      status_changed_at: iso(r.statusChangedAt),
    }));
    return { rows, count: rows.length };
  }

  if (dataset === "roster") {
    const roster = await loadAdminRosterAll(filters);
    // Account-level columns only. Nothing here comes from `contacts`.
    const rows = roster.map((r) => ({
      user_id: r.userId,
      email: r.email ?? "",
      first_name: r.firstName ?? "",
      last_name: r.lastName ?? "",
      plan: r.plan,
      plan_source: r.planSource,
      suspended_at: iso(r.suspendedAt),
      signed_up_at: iso(r.signupAt),
      last_seen_at: iso(r.lastSeenAt),
      onboarded_at: iso(r.onboardedAt),
      wizard_completed_at: iso(r.wizardCompletedAt),
      contacts: r.counts.contacts,
      interactions: r.counts.interactions,
      imports: r.counts.imports,
      chat_messages: r.counts.chatMessages,
      ai_calls: r.counts.aiCalls,
      ai_failures: r.counts.aiFailures,
      ai_input_tokens: r.aiTokens.input,
      ai_output_tokens: r.aiTokens.output,
      ai_estimated_cost: formatCostMicros(r.estimatedCostMicros) ?? "",
      ai_provider: r.aiProvider ?? "",
      ai_model: r.aiModel ?? "",
      has_provider_key: r.hasProviderKey,
      subscription_status: r.subscriptionStatus ?? "",
      subscription_period_end: iso(r.subscriptionPeriodEnd),
      lifetime_purchased_at: iso(r.lifetimePurchasedAt),
      stripe_customer_id: r.stripeCustomerId ?? "",
    }));
    return { rows, count: rows.length };
  }

  if (dataset === "health") {
    const health = await getAdminHealth();
    const rows: Array<Record<string, unknown>> = [
      ...health.missingKeyAccounts.map((r) => ({
        kind: "missing-key",
        user_id: r.userId,
        email: r.email ?? "",
        detail: `no ${r.provider} key`,
        at: "",
      })),
      ...health.imports.map((r) => ({
        kind: r.stalled ? "import-stalled" : "import-failed",
        user_id: r.userId,
        email: r.email ?? "",
        detail: r.errorMessage ?? r.fileName ?? r.importType,
        at: iso(r.updatedAt),
      })),
      ...health.connections.map((r) => ({
        kind: `${r.provider}-${r.reason}`,
        user_id: r.userId,
        email: r.email ?? "",
        detail: r.status,
        at: iso(r.updatedAt),
      })),
      ...health.calendars.map((r) => ({
        kind: "calendar-error",
        user_id: r.userId,
        email: r.email ?? "",
        detail: r.lastSyncError ?? "",
        at: iso(r.lastSyncedAt),
      })),
      ...health.aiErrors.map((g) => ({
        kind: "ai-error",
        user_id: "",
        email: "",
        detail: `${g.errorKind} ${g.provider}/${g.model} ${g.operation} — ${g.failures} failures across ${g.accounts} accounts`,
        at: iso(g.lastAt),
      })),
    ];
    return { rows, count: rows.length };
  }

  // The audit log itself. Reasons are the operator's own words, not user content.
  const log = await loadAuditLog({ pageSize: 200 });
  const rows = log.rows.map((r) => ({
    at: iso(r.createdAt),
    action: r.action,
    admin_user_id: r.adminUserId,
    target_user_id: r.targetUserId ?? "",
    target_email: r.targetEmail ?? "",
    resource_type: r.resourceType ?? "",
    resource_id: r.resourceId ?? "",
    reason: r.reason ?? "",
    detail: JSON.stringify(r.detail ?? {}),
  }));
  return { rows, count: rows.length };
}
