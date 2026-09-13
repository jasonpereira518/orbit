import { Download } from "lucide-react";
import { AdminPageHeader, AdminPanel, MetricTile } from "@/components/admin/primitives";
import {
  HealthLiveBody,
  HealthLiveProvider,
  type HealthLiveData,
} from "@/components/admin/health-live";
import { getAdminHealth } from "@/lib/admin-health";
import {
  getBugSignatures,
  getCronHealth,
  getErrorEventSummary,
  getOpsStatus,
  getOutreachQueueHealth,
  getWebhookHealth,
} from "@/lib/admin-system";

export const metadata = { title: "Admin · Health" };

/**
 * What is broken across every account, right now.
 *
 * The inspector has always shown these signals, one account at a time — which means a dead
 * Gmail token was only ever visible if you happened to open the one page it lived on, and
 * nobody opens two hundred pages. Same predicates, gathered by the question they answer.
 *
 * Every row names the account and links into its inspector, and carries the button that
 * fixes it. A triage screen you cannot act on from is a list nobody comes back to.
 *
 * Everything below the header polls for updates rather than sitting static until a manual
 * reload — see `health-live.tsx`. "Known bug signatures" is the one panel that stays
 * server-rendered only: it changes on a data-quality timescale, not a twenty-second one.
 */
export default async function AdminHealthPage() {
  // `getAdminHealth` answers "what is broken for an account". Everything below answers
  // "what is broken about Orbit" — no person to name, no button to press, which is
  // precisely why none of it was visible before. Each degrades independently so this page
  // still renders if one instrumentation table is missing.
  const [health, cron, webhooks, errors, outreach, bugs, ops] = await Promise.all([
    getAdminHealth(),
    getCronHealth("imports.process-stalled").catch(() => null),
    getWebhookHealth().catch(() => null),
    getErrorEventSummary().catch(() => null),
    getOutreachQueueHealth().catch(() => null),
    getBugSignatures().catch(() => null),
    getOpsStatus().catch(() => null),
  ]);

  const totalBroken =
    health.connections.length +
    health.calendars.length +
    health.imports.length +
    health.missingKeyAccounts.length;

  const initialLive: HealthLiveData = { health, cron, webhooks, errors, outreach, ops };

  return (
    <>
      <AdminPageHeader
        title="Health"
        subtitle={
          totalBroken === 0 ? (
            "Nothing is failing across any account."
          ) : (
            <>
              <span className="tabular-nums">{totalBroken}</span> thing
              {totalBroken === 1 ? "" : "s"} need attention across all accounts
            </>
          )
        }
        action={
          <a
            href="/api/admin/export?dataset=health&format=csv"
            className="inline-flex items-center gap-1.5 rounded-md border border-border/70 px-2.5 py-1 text-xs text-muted-foreground transition-colors duration-fast hover:text-foreground"
          >
            <Download className="size-3" aria-hidden />
            Export CSV
          </a>
        }
      />

      <HealthLiveProvider initial={initialLive}>
        <HealthLiveBody bugsEmbeddingsMissingVector={bugs?.embeddingsMissingVector ?? null} />
      </HealthLiveProvider>

      {bugs && (
        <div className="mt-6">
          <AdminPanel title="Known bug signatures">
            <div className="grid gap-3 sm:grid-cols-3">
              <MetricTile
                label="Confirmed, no reminder"
                value={bugs.confirmedWithoutReminder}
                tone={bugs.confirmedWithoutReminder > 0 ? "danger" : "muted"}
                hint="a confirm that half-committed"
              />
              <MetricTile
                label="Unindexed embeddings"
                value={
                  bugs.embeddingsMissingVector === null
                    ? "—"
                    : bugs.embeddingsMissingVector
                }
                tone={bugs.embeddingsMissingVector ? "danger" : "muted"}
                hint="invisible to semantic search"
              />
              <MetricTile
                label="Inlined avatars"
                value={bugs.inlinedAvatars}
                tone={bugs.inlinedAvatars > 0 ? "danger" : "muted"}
                hint="base64 in Postgres — Blob unset"
              />
            </div>
          </AdminPanel>
        </div>
      )}
    </>
  );
}
