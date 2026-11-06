import Link from "next/link";
import { AlertTriangle, CheckCircle2, Download } from "lucide-react";
import { OpsTabs } from "@/components/admin/admin-tabs";
import { AdminPageHeader } from "@/components/admin/primitives";
import { lastProviderProblemCount } from "@/lib/admin-providers";
import { cn } from "@/lib/utils";
import { loadCron, loadHealth, loadOps, loadWebhooks } from "./data";
import { OpsRefreshButton } from "./refresh-button";

const ACCOUNTS = "/admin/health";
const SYSTEMS = "/admin/health/systems";
const AI = "/admin/health/ai";

/**
 * The chrome every Ops tab shares: header, the one-line status banner and the tab row.
 *
 * The banner rolls every signal into one line so the first glance answers "is anything
 * wrong" without opening a tab; each chip links to the tab that owns it, and the tab badges
 * count the same things. A server-rendered snapshot — Refresh re-reads it.
 *
 * `providerProblems` comes from the Systems tab, which runs the real provider checks; the
 * other tabs read the last stored result instead of calling twelve APIs to colour a chip.
 */
export async function OpsShell({
  providerProblems,
  children,
}: {
  providerProblems?: number;
  children: React.ReactNode;
}) {
  const [health, ops, cron, webhooks, providersDown] = await Promise.all([
    loadHealth(),
    loadOps(),
    loadCron(),
    loadWebhooks(),
    providerProblems ?? lastProviderProblemCount().catch(() => 0),
  ]);

  const criticalOpen = ops?.openAlerts.filter((a) => a.severity === "critical").length ?? 0;
  const openAlerts = ops?.openAlerts.length ?? 0;
  const accountIssues =
    health.connections.length +
    health.calendars.length +
    health.imports.length +
    health.missingKeyTotal;
  const sweepBad = Boolean(ops) && (!ops!.lastSweep || ops!.sweepQuiet);
  const cronBad = Boolean(cron) && (!cron!.lastRun || cron!.missed);
  const webhooksBad = Boolean(
    webhooks?.byOutcome.some((o) => o.outcome === "invalid" || o.outcome === "error")
  );
  const systemIssues =
    (sweepBad ? 1 : 0) + (cronBad ? 1 : 0) + (webhooksBad ? 1 : 0) + providersDown;

  type Problem = { label: string; href: string; tone: "danger" | "warn" };
  const problems: Problem[] = [];
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (criticalOpen > 0) {
    problems.push({ label: plural(criticalOpen, "critical alert"), href: ACCOUNTS, tone: "danger" });
  }
  if (openAlerts > criticalOpen) {
    problems.push({ label: plural(openAlerts - criticalOpen, "open alert"), href: ACCOUNTS, tone: "warn" });
  }
  if (accountIssues > 0) {
    problems.push({ label: plural(accountIssues, "account issue"), href: ACCOUNTS, tone: "warn" });
  }
  if (sweepBad) problems.push({ label: "Ops sweep is quiet", href: SYSTEMS, tone: "danger" });
  if (cronBad) problems.push({ label: "Nightly job missed", href: SYSTEMS, tone: "danger" });
  if (webhooksBad) problems.push({ label: "Webhook failures", href: SYSTEMS, tone: "danger" });
  if (providersDown > 0) {
    problems.push({ label: `${plural(providersDown, "provider")} down`, href: SYSTEMS, tone: "danger" });
  }
  if (health.aiErrors.length > 0) {
    problems.push({ label: plural(health.aiErrors.length, "AI failure group"), href: AI, tone: "warn" });
  }
  const anyDanger = problems.some((p) => p.tone === "danger");

  return (
    <>
      <AdminPageHeader
        title="Ops"
        subtitle={
          accountIssues === 0 ? (
            "Nothing is failing across any account."
          ) : (
            <>
              <span className="tabular-nums">{accountIssues}</span> thing
              {accountIssues === 1 ? "" : "s"} need attention across all accounts
            </>
          )
        }
        action={
          <span className="flex flex-wrap items-center gap-2">
            <OpsRefreshButton />
            <a
              href="/api/admin/export?dataset=health&format=csv"
              className="inline-flex items-center gap-1.5 rounded-md border border-border/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors duration-fast hover:text-foreground"
            >
              <Download className="size-3" aria-hidden />
              Export CSV
            </a>
          </span>
        }
      />

      <div
        className={cn(
          "mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border px-4 py-3",
          problems.length === 0
            ? "border-primary/30 bg-primary/5"
            : anyDanger
              ? "border-destructive/40 bg-destructive/5"
              : "border-warning/40 bg-warning/5"
        )}
      >
        <span className="flex items-center gap-2 text-sm font-medium">
          {problems.length === 0 ? (
            <>
              <CheckCircle2 className="size-4 text-primary" aria-hidden />
              All clear
            </>
          ) : (
            <>
              <AlertTriangle
                className={cn("size-4", anyDanger ? "text-destructive" : "text-warning")}
                aria-hidden
              />
              Needs attention
            </>
          )}
        </span>
        {problems.length === 0 ? (
          <span className="text-xs text-muted-foreground">
            Sweep, nightly job, webhooks, providers and every account are healthy.
          </span>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {problems.map((p) => (
              <li key={p.label}>
                <Link
                  href={p.href}
                  className={cn(
                    "block rounded-full border px-2.5 py-0.5 text-xs transition-colors duration-fast hover:bg-muted/60",
                    p.tone === "danger"
                      ? "border-destructive/40 text-destructive"
                      : // amber-800 in light: --warning (amber-700) on this tinted strip was 4.42:1.
                        "border-warning/40 text-amber-800 dark:text-warning"
                  )}
                >
                  {p.label}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <OpsTabs
        counts={{
          [ACCOUNTS]: openAlerts + accountIssues,
          [SYSTEMS]: systemIssues,
          [AI]: health.aiErrors.length,
        }}
      />

      {children}
    </>
  );
}
