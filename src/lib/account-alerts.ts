import { AI_PROVIDERS, type AiProvider } from "@/lib/ai-providers";
import type { Plan, PlanSource } from "@/lib/plan-limits";

/**
 * What is wrong with an account, and how to say it to the person who owns it.
 *
 * PURE ON PURPOSE — no database import, directly or transitively, exactly like
 * `surfaces.ts`. The notifications panel is a client component and renders these; a client
 * component that imports anything reaching `@/db` fails the build with a `node:fs`
 * chunking error that names neither file. `src/lib/account-health.ts` is the server half
 * that loads the facts, the same split as `plan-limits.ts`/`entitlements.ts`.
 *
 * Two layers, because there are two audiences:
 *
 *  - `evaluateAccountHealth` takes plain already-fetched values (never Drizzle rows) and
 *    returns findings.
 *  - `toAccountAlerts` is the copy layer that turns findings into rows a user reads.
 *
 * RELATIONSHIP TO THE ADMIN INSPECTOR. `admin-user-detail.ts` computes its own health list
 * and deliberately does NOT call this. It is a diagnostic that should over-report; this is
 * a notification surface that must under-report, and four predicates differ as a result —
 * expired tokens, calendar severity, the onboarding gate, and the import window. The list
 * of differences and the reasoning for each is kept in one place, above that file's
 * `const health` declaration. Check both when changing either.
 *
 * ALERTS ARE NOT DISMISSIBLE. They clear only when the underlying condition is fixed.
 * That is what makes them trustworthy, and it is also the constraint every predicate here
 * has to respect: anything derived from a HISTORICAL row must be windowed, or a single bad
 * day becomes a permanent badge. See `IMPORT_ALERT_WINDOW_MS`.
 */

/** How many alerts the server will ever return. A pathological account cannot balloon the payload. */
export const MAX_ACCOUNT_ALERTS = 6;

/**
 * How many the panel shows before collapsing the rest behind "+N more".
 * Three rather than two since the rows became single-line — at ~28px each that is still
 * less height than the two four-line rows this replaced.
 */
export const ALERTS_COLLAPSED_VISIBLE = 3;

/**
 * How long an import may sit in `processing` before it is considered stuck.
 * Matches `STALLED_IMPORT_MS` in `admin-health.ts` and the inline 10 minutes at
 * `admin-user-detail.ts`. Deliberately NOT the cron stall threshold — `admin-system.ts`
 * explains why those two must not be reconciled.
 */
export const STALLED_IMPORT_MS = 10 * 60 * 1000;

/**
 * How far back a failed or stuck import still counts as a live problem.
 *
 * Load-bearing. Alerts cannot be dismissed, so without this an import that failed once in
 * March would sit in the panel forever with no way for the user to acknowledge it.
 */
export const IMPORT_ALERT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Fraction of the free contact cap at which the warning appears. */
export const CONTACT_CAP_WARN_RATIO = 0.9;

/** Longest system-authored detail string (a provider error) shown verbatim in a body. */
const MAX_DETAIL_CHARS = 140;

export type HealthCode =
  | "ai.no_key"
  /**
   * Reserved, not implemented in v1. Anthropic has no embeddings API, so a user with a
   * perfectly valid Anthropic key still has broken semantic search unless they also hold
   * an OpenAI or Gemini key (see `resolveEmbeddingBackend` in `ai.ts`). Declaring the slot
   * now means adding it later is not a type change.
   */
  | "ai.no_embedding_key"
  | "connection.gmail"
  | "connection.outlook"
  | "calendar.sync_error"
  | "import.failed"
  | "import.stalled"
  | "plan.contact_cap_reached"
  | "plan.contact_cap_near"
  | "billing.past_due";

/**
 * `error` means part of the product is dark right now. `warn` means this needs attention
 * but nothing is blocked. Only `error` lights the dot on the bell, so this distinction is
 * the only thing keeping that dot meaningful.
 */
export type HealthSeverity = "error" | "warn";

export type ConnectionFacts = {
  status: "active" | "needs_reauth";
  emailAddress: string;
  tokenExpiresAt: Date | null;
  hasRefreshToken: boolean;
};

/**
 * Everything the predicates need, as plain values. No Drizzle rows and no `userId`, which
 * is what keeps this module pure and testable without a database — `evaluateAccountHealth`
 * is a function of its input alone.
 */
export type HealthInput = {
  aiProvider: AiProvider;
  /** Personal key for the selected provider, OR a usable env key. Never a decrypted secret. */
  hasAiKey: boolean;
  onboardingCompletedAt: Date | null;

  /** null = no connection at all, or OAuth is unconfigured on this deployment. */
  gmail: ConnectionFacts | null;
  outlook: ConnectionFacts | null;

  calendarErrorCount: number;
  calendarErrorLabel: string | null;
  calendarErrorDetail: string | null;

  importFailedCount: number;
  importFailedLabel: string | null;
  importFailedDetail: string | null;
  importStalledCount: number;
  importStalledLabel: string | null;
  importStalledRows: number | null;
  importStalledTotal: number | null;

  plan: Plan;
  planSource: PlanSource;
  subscriptionStatus: "active" | "past_due" | "canceled" | null;
  subscriptionPeriodEnd: Date | null;
  /** null = unlimited, so the cap predicates do not apply. */
  contactLimit: number | null;
  /** null when `contactLimit` is null — the count is not queried for paid accounts. */
  contactCount: number | null;
};

export type HealthFinding = {
  code: HealthCode;
  severity: HealthSeverity;
  /** Interpolation values for whichever copy layer consumes this finding. */
  data: Record<string, string | number | null>;
};

export type AccountAlertKind =
  | "ai_key"
  | "connection"
  | "calendar"
  | "import"
  | "billing"
  | "plan_limit";

export type AccountAlert = {
  /**
   * Stable and CONDITION-derived — never a row id, never a timestamp. Three things depend
   * on that: React keys stay put across the panel's 120s polls so nothing re-mounts under
   * the cursor; an aggregate alert ("3 imports didn't finish") has one id rather than
   * three; and the `alert:` prefix namespaces these away from panel item ids
   * (`reminder:`, `followup:`, …), which is what makes the desktop-notification leak
   * guard in the smoke test a one-line `startsWith` check.
   */
  id: string;
  code: HealthCode;
  kind: AccountAlertKind;
  severity: HealthSeverity;
  title: string;
  body: string | null;
  /** `external` = leaves the app shell, so the renderer uses `WarpLink` rather than `Link`. */
  cta: { label: string; href: string; external: boolean } | null;
  /** Whether the user may hide this. See `DISMISSIBLE_CODES` — NOT the same as severity. */
  dismissible: boolean;
  /**
   * The surface whose remedy this alert points at. `account-health.ts` drops the alert
   * entirely when an operator has hidden that surface — an alert the user cannot act on is
   * worse than silence. Null means the remedy is unconditionally reachable.
   */
  surfaceKey: string | null;
};

function truncate(value: string | null | undefined, max = MAX_DETAIL_CHARS) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function providerLabel(provider: AiProvider) {
  return AI_PROVIDERS.find((p) => p.id === provider)?.label ?? "AI";
}

/**
 * The predicates. Order of pushes is irrelevant — `sortAccountAlerts` decides display
 * order — but each `if` is deliberately independent so a new condition cannot accidentally
 * suppress an existing one.
 */
export function evaluateAccountHealth(
  input: HealthInput,
  now: Date = new Date()
): HealthFinding[] {
  const findings: HealthFinding[] = [];
  const nowMs = now.getTime();

  // --- AI key -------------------------------------------------------------------------
  // Gated on completed onboarding. A brand-new account has no key by definition, and the
  // setup wizard already asks for one; without this gate anyone who abandons onboarding is
  // met by a red dot before they have done anything at all.
  if (!input.hasAiKey && input.onboardingCompletedAt !== null) {
    findings.push({
      code: "ai.no_key",
      severity: "error",
      data: { provider: input.aiProvider, providerLabel: providerLabel(input.aiProvider) },
    });
  }

  // --- Mailbox connections ------------------------------------------------------------
  // NOTE: `tokenExpiresAt < now` on its own is the NORMAL state and must never fire here.
  // `getValidAccessToken` refreshes transparently whenever a refresh token exists and
  // writes the row back to `active`, so alerting on plain expiry would flag every healthy
  // connected account within an hour. Only a missing refresh token is unrecoverable —
  // and that is already marked `needs_reauth` on next use, so this clause is really a
  // catch for accounts that have not made a call since the token lapsed.
  for (const [code, conn] of [
    ["connection.gmail", input.gmail],
    ["connection.outlook", input.outlook],
  ] as const) {
    if (!conn) continue;
    const dead =
      conn.status !== "active" ||
      (conn.tokenExpiresAt !== null &&
        conn.tokenExpiresAt.getTime() < nowMs &&
        !conn.hasRefreshToken);
    if (dead) {
      findings.push({
        code,
        severity: "error",
        data: { emailAddress: conn.emailAddress },
      });
    }
  }

  // --- Calendar feeds -----------------------------------------------------------------
  // `warn`, not `error` as the admin inspector has it. `lastSyncStatus` is sticky until the
  // next SUCCESSFUL sync, so one transient ICS 503 would otherwise pin a red dot on the
  // bell for days while nothing in the product is actually blocked.
  if (input.calendarErrorCount > 0) {
    findings.push({
      code: "calendar.sync_error",
      severity: "warn",
      data: {
        count: input.calendarErrorCount,
        label: input.calendarErrorLabel,
        detail: truncate(input.calendarErrorDetail),
      },
    });
  }

  // --- Imports ------------------------------------------------------------------------
  // Both windowed by the caller to `IMPORT_ALERT_WINDOW_MS`; see the constant.
  if (input.importFailedCount > 0) {
    findings.push({
      code: "import.failed",
      severity: "error",
      data: {
        count: input.importFailedCount,
        label: input.importFailedLabel,
        detail: truncate(input.importFailedDetail),
      },
    });
  }
  if (input.importStalledCount > 0) {
    findings.push({
      code: "import.stalled",
      severity: "warn",
      data: {
        count: input.importStalledCount,
        label: input.importStalledLabel,
        rows: input.importStalledRows,
        total: input.importStalledTotal,
      },
    });
  }

  // --- Contact cap --------------------------------------------------------------------
  // The two are mutually exclusive by construction (`>=` vs `<`), never by ordering.
  if (input.contactLimit !== null && input.contactCount !== null) {
    const { contactLimit: limit, contactCount: used } = input;
    if (used >= limit) {
      findings.push({
        code: "plan.contact_cap_reached",
        severity: "error",
        data: { limit, used },
      });
    } else if (used >= Math.floor(limit * CONTACT_CAP_WARN_RATIO)) {
      findings.push({
        code: "plan.contact_cap_near",
        severity: "warn",
        data: { limit, used, remaining: limit - used },
      });
    }
  }

  // --- Billing ------------------------------------------------------------------------
  // `planSource === "subscription"` is the honest expression of `subscriptionIsLive`
  // without importing the server module: `resolvePlan` only reports that source while the
  // subscription still grants access. It also correctly suppresses this for a comped or
  // Lifetime holder whose card happens to have bounced — they are losing nothing. Once the
  // subscription truly lapses the plan resolves to free, and the contact cap becomes the
  // honest alert instead of a stale "past due".
  if (
    input.subscriptionStatus === "past_due" &&
    input.planSource === "subscription"
  ) {
    findings.push({
      code: "billing.past_due",
      severity: "warn",
      data: {
        periodEnd: input.subscriptionPeriodEnd
          ? input.subscriptionPeriodEnd.toISOString()
          : null,
      },
    });
  }

  return findings;
}

/**
 * Which alerts the user may hide, and — more to the point — which they may not.
 *
 * This is deliberately NOT severity. The two axes look alike and are not: severity says
 * how loudly to shout (only `error` lights the bell's dot), while this says whether the
 * alert is still true in a way that matters after you have read it. They cross over in
 * both directions, which is exactly why this is its own list:
 *
 *   - `import.failed` is an ERROR and IS dismissible. It is a fact about something that
 *     already happened; nothing in the product is unavailable because of it, and the
 *     import will not un-fail if you keep staring at it.
 *   - `billing.past_due` is a WARNING and is NOT dismissible. Access continues for now,
 *     so it is not an error — but hiding it is how someone loses Orbit Pro without
 *     noticing, and it disappears the moment the card is fixed.
 *
 * The test for a new code: is a capability unavailable right now, and does it stay
 * unavailable until this person acts? If yes it stays put. Anything historical, advisory,
 * or self-healing can be hidden.
 */
const DISMISSIBLE_CODES: ReadonlySet<HealthCode> = new Set<HealthCode>([
  // Already happened. The import is over; the row is a receipt, not a blocker.
  "import.failed",
  // Retried automatically by the stalled-import cron.
  "import.stalled",
  // One input among several, and `lastSyncStatus` stays "error" until the next SUCCESS —
  // so a single transient feed failure would otherwise sit there for days.
  "calendar.sync_error",
  // Purely advisory: nothing is blocked until the cap is actually reached.
  "plan.contact_cap_near",
]);

/**
 * Non-dismissible, and why each one has to be:
 *   `ai.no_key` / `ai.no_embedding_key` — every AI feature is dark until a key exists.
 *   `connection.gmail` / `connection.outlook` — sync and mailbox scans stay paused.
 *   `plan.contact_cap_reached` — no new contacts can be created at all.
 *   `billing.past_due` — see the note above.
 */
export function isDismissible(code: HealthCode): boolean {
  return DISMISSIBLE_CODES.has(code);
}

const KIND_BY_CODE: Record<HealthCode, AccountAlertKind> = {
  "ai.no_key": "ai_key",
  "ai.no_embedding_key": "ai_key",
  "connection.gmail": "connection",
  "connection.outlook": "connection",
  "calendar.sync_error": "calendar",
  "import.failed": "import",
  "import.stalled": "import",
  "plan.contact_cap_reached": "plan_limit",
  "plan.contact_cap_near": "plan_limit",
  "billing.past_due": "billing",
};

/**
 * Display order, ranked by how much of the product is dark: no key kills every AI feature,
 * a dead mailbox kills sync, billing and caps block writes, a failed import is history,
 * and a calendar feed is one input among many.
 */
const KIND_RANK: Record<AccountAlertKind, number> = {
  ai_key: 0,
  connection: 1,
  billing: 2,
  plan_limit: 3,
  import: 4,
  calendar: 5,
};

/** Fully deterministic tiebreak, so two calls a second apart never reorder the list. */
const CODE_RANK: HealthCode[] = [
  "ai.no_key",
  "ai.no_embedding_key",
  "connection.gmail",
  "connection.outlook",
  "billing.past_due",
  "plan.contact_cap_reached",
  "plan.contact_cap_near",
  "import.failed",
  "import.stalled",
  "calendar.sync_error",
];

function str(value: string | number | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function int(value: string | number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function plural(n: number, one: string, many: string) {
  return n === 1 ? one : many;
}

/** Turns findings into the rows a user reads. The admin console keeps its own wording. */
export function toAccountAlerts(findings: HealthFinding[]): AccountAlert[] {
  const alerts: AccountAlert[] = [];

  for (const f of findings) {
    const base = {
      id: `alert:${f.code}`,
      code: f.code,
      kind: KIND_BY_CODE[f.code],
      severity: f.severity,
      dismissible: isDismissible(f.code),
    };

    switch (f.code) {
      case "ai.no_key": {
        alerts.push({
          ...base,
          title: `Add your ${str(f.data.providerLabel) ?? "AI"} API key`,
          body:
            "Capture, chat, suggestions and search stay switched off until Orbit has a key. Orbit never charges you for AI — you bring your own.",
          cta: { label: "Open AI settings", href: "/settings#settings-ai", external: false },
          surfaceKey: "settings.ai",
        });
        break;
      }

      case "ai.no_embedding_key": {
        // Reserved; `evaluateAccountHealth` never emits this yet.
        alerts.push({
          ...base,
          title: "Semantic search needs an OpenAI or Gemini key",
          body:
            "Anthropic has no embeddings API, so search falls back to keywords until you add a second key.",
          cta: { label: "Open AI settings", href: "/settings#settings-ai", external: false },
          surfaceKey: "settings.ai",
        });
        break;
      }

      case "connection.gmail":
      case "connection.outlook": {
        const name = f.code === "connection.gmail" ? "Gmail" : "Outlook";
        const email = str(f.data.emailAddress);
        alerts.push({
          ...base,
          title: `Reconnect ${name}`,
          body: `${email ? `Your ${email} session` : "Your session"} expired. Contact sync and mailbox scans are paused until you sign in again.`,
          cta: {
            label: "Reconnect",
            // Straight at that provider's card. `ImportHub` maps the anchor to its tab,
            // so this opens the right tab as well as scrolling to it.
            href:
              f.code === "connection.gmail"
                ? "/imports#import-google-contacts"
                : "/imports#import-outlook-contacts",
            external: false,
          },
          surfaceKey: "page.imports",
        });
        break;
      }

      case "calendar.sync_error": {
        const n = int(f.data.count) ?? 1;
        const label = str(f.data.label);
        alerts.push({
          ...base,
          title:
            n === 1
              ? `${label ?? "Calendar feed"} isn't syncing`
              : `${n} calendar feeds aren't syncing`,
          body: str(f.data.detail) ?? "Orbit couldn't read the feed on its last try.",
          cta: {
            label: "Check calendar feeds",
            // `/settings#settings-calendar` is Orbit's OUTBOUND ICS feed. This alert is
            // about an INBOUND subscription in `calendar_subscriptions`, which is managed
            // on the imports page — the old link sent people to an unrelated card.
            href: "/imports#import-panel-calendar",
            external: false,
          },
          surfaceKey: "page.imports",
        });
        break;
      }

      case "import.failed": {
        const n = int(f.data.count) ?? 1;
        const label = str(f.data.label);
        const detail = str(f.data.detail);
        alerts.push({
          ...base,
          title:
            n === 1 ? "An import didn't finish" : `${n} imports didn't finish`,
          body:
            n === 1
              ? [label, detail].filter(Boolean).join(" — ") || null
              : "Open imports to see which ones and try again.",
          cta: {
            label: "Open imports",
            href: "/imports#import-history",
            external: false,
          },
          surfaceKey: "page.imports",
        });
        break;
      }

      case "import.stalled": {
        const n = int(f.data.count) ?? 1;
        const label = str(f.data.label);
        const rows = int(f.data.rows) ?? 0;
        const total = int(f.data.total);
        alerts.push({
          ...base,
          title: n === 1 ? "An import is stuck" : `${n} imports are stuck`,
          body:
            n === 1
              ? `${label ?? "An import"} stopped at ${rows} of ${total ?? "?"} rows. Orbit retries stuck imports automatically, or you can restart it yourself.`
              : "Orbit retries stuck imports automatically, or you can restart them yourself.",
          cta: {
            label: "Open imports",
            href: "/imports#import-history",
            external: false,
          },
          surfaceKey: "page.imports",
        });
        break;
      }

      case "plan.contact_cap_reached": {
        const limit = int(f.data.limit) ?? 0;
        alerts.push({
          ...base,
          title: `You've reached the ${limit}-contact limit`,
          body:
            "Orbit won't add new people until you upgrade. Everything already in your orbit stays fully available — reads, edits and interaction logging are never gated.",
          cta: { label: "See plans", href: "/pricing", external: true },
          surfaceKey: null,
        });
        break;
      }

      case "plan.contact_cap_near": {
        const limit = int(f.data.limit) ?? 0;
        const used = int(f.data.used) ?? 0;
        const remaining = int(f.data.remaining) ?? Math.max(0, limit - used);
        alerts.push({
          ...base,
          title: `${remaining} ${plural(remaining, "contact", "contacts")} left on the free plan`,
          body: `You've added ${used} of ${limit}.`,
          cta: { label: "See plans", href: "/pricing", external: true },
          surfaceKey: null,
        });
        break;
      }

      case "billing.past_due": {
        const periodEnd = str(f.data.periodEnd);
        const until = periodEnd ? new Date(periodEnd) : null;
        const readable =
          until && !Number.isNaN(until.getTime())
            ? until.toLocaleDateString(undefined, { month: "short", day: "numeric" })
            : null;
        alerts.push({
          ...base,
          title: "Your last payment didn't go through",
          body: readable
            ? `Orbit Pro stays on until ${readable}. Update your card to keep it.`
            : "Update your payment method to keep Orbit Pro.",
          cta: {
            label: "Manage billing",
            href: "/settings#settings-plan",
            external: false,
          },
          surfaceKey: "settings.plan",
        });
        break;
      }
    }
  }

  return alerts;
}

/**
 * Severity, then how much of the product is dark, then a fixed code order.
 *
 * NO TIMESTAMPS anywhere in this comparison, deliberately. The panel re-fetches every 120
 * seconds; a time-ordered list would silently reorder itself between polls and move a
 * button out from under the cursor mid-reach.
 */
export function sortAccountAlerts(alerts: AccountAlert[]): AccountAlert[] {
  return [...alerts].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
    const kind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (kind !== 0) return kind;
    return CODE_RANK.indexOf(a.code) - CODE_RANK.indexOf(b.code);
  });
}

/** Whether the bell should carry its dot. Only `error` counts — see `HealthSeverity`. */
export function hasErrorAlert(alerts: readonly AccountAlert[]): boolean {
  return alerts.some((a) => a.severity === "error");
}
