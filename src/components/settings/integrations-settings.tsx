"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronRight } from "lucide-react";
import type { getSettings } from "@/actions/settings";
import {
  getIntegrationStatuses,
  type IntegrationStatuses,
} from "@/actions/integrations";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/settings-section";
import {
  INTEGRATION_PARAM,
  INTEGRATION_TAB_FOR_LEGACY_HASH,
  INTEGRATION_TAB_GROUPS,
  INTEGRATION_TABS,
  isIntegrationTabId,
  type IntegrationTabId,
} from "@/components/settings/sections";
import {
  INTEGRATION_ICONS,
  IntegrationsDialog,
  StatusDot,
  statusText,
  tabForImportJob,
} from "@/components/settings/integrations-dialog";
import { useImportJob } from "@/lib/import-job-runner";
import { cn } from "@/lib/utils";

type Settings = Awaited<ReturnType<typeof getSettings>>;

/**
 * The Integrations group's one card: what is connected, at a glance, and the way into the
 * dialog where each of them is set up.
 *
 * Opened three ways besides a click, all of which have to land on the right tab:
 *   - `?integration=<tab>` — the link every other part of the app now uses
 *     (`integrationHref`), and the `returnTo` a Google or Microsoft consent screen sends the
 *     user back to;
 *   - `#settings-ai` and the other anchors these tabs had when they were cards on the page,
 *     for bookmarks and any link still written the old way;
 *   - an import job running when Settings loads, which opens on its importer's tab.
 */
export function IntegrationsSettings({
  tabs,
  initialSettings,
  canUseRecruiters,
}: {
  /** Visible tabs, in order — hidden surfaces already filtered out by the page. */
  tabs: IntegrationTabId[];
  initialSettings: Settings;
  canUseRecruiters: boolean;
}) {
  const searchParams = useSearchParams();
  const job = useImportJob();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<IntegrationTabId>(tabs[0] ?? "ai");
  const [statuses, setStatuses] = useState<IntegrationStatuses | null>(null);

  const refreshStatuses = useCallback(() => {
    let settled = false;
    const attempt = () =>
      getIntegrationStatuses().then(
        (next) => {
          settled = true;
          setStatuses(next);
        },
        () => {
          // The rows just keep saying "Checking…"; nothing here is worth an error toast.
        }
      );
    void attempt();
    // A server action queued when a `history.replaceState` lands is dropped by the router
    // and never settles — and the importer cards strip their OAuth params exactly that way
    // as they mount. Ask once more rather than leave every row on "Checking…".
    window.setTimeout(() => {
      if (!settled) void attempt();
    }, 6_000);
  }, []);

  useEffect(refreshStatuses, [refreshStatuses]);

  const openOn = useCallback(
    (next?: IntegrationTabId) => {
      const running = job?.status === "running" ? tabForImportJob(job.kind) : null;
      const target = next ?? (running && tabs.includes(running) ? running : undefined);
      if (target && tabs.includes(target)) setTab(target);
      setOpen(true);
    },
    [job, tabs]
  );

  // `?integration=` — read through `useSearchParams` so a link clicked while already on
  // Settings (the notifications panel is reachable from here) opens the dialog without a
  // remount. Opened while rendering rather than in an effect, so the dialog is up in the
  // same paint the URL asks for it; `handled` makes each request count once.
  const requested = searchParams.get(INTEGRATION_PARAM);
  const [handled, setHandled] = useState<string | null>(null);
  if (requested !== handled) {
    setHandled(requested);
    if (requested && isIntegrationTabId(requested) && tabs.includes(requested)) {
      setTab(requested);
      setOpen(true);
    }
  }

  // The old per-card anchors.
  useEffect(() => {
    function openForHash() {
      const target = INTEGRATION_TAB_FOR_LEGACY_HASH[window.location.hash.slice(1)];
      if (!target || !tabs.includes(target)) return;
      setTab(target);
      setOpen(true);
    }
    openForHash();
    window.addEventListener("hashchange", openForHash);
    return () => window.removeEventListener("hashchange", openForHash);
  }, [tabs]);

  /**
   * Spend the deep link — `?integration=` or a legacy hash — so a reload shows the page
   * rather than reopening the dialog.
   *
   * On close, and only on close. Next patches `history.replaceState` into a router
   * "restore", and a restore that lands while a server action is queued drops that action
   * without ever settling it. Stripping the param on open did exactly that to the panel
   * that had just mounted: its first load never left the browser, and it sat on its
   * skeleton until its own timeout. By the time the dialog closes, nothing is queued.
   */
  function clearDeepLink() {
    const params = new URLSearchParams(window.location.search);
    const hadParam = params.has(INTEGRATION_PARAM);
    params.delete(INTEGRATION_PARAM);
    const legacyHash = INTEGRATION_TAB_FOR_LEGACY_HASH[window.location.hash.slice(1)];
    if (!hadParam && !legacyHash) return;
    const rest = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${rest ? `?${rest}` : ""}${legacyHash ? "" : window.location.hash}`
    );
  }

  if (tabs.length === 0) return null;

  const groups = INTEGRATION_TAB_GROUPS.map((group) => ({
    ...group,
    tabs: INTEGRATION_TABS.filter((t) => t.group === group.key && tabs.includes(t.id)),
  })).filter((group) => group.tabs.length > 0);

  const connected = statuses
    ? tabs.filter((id) => {
        const s = statuses[id];
        return s !== undefined && s !== "unknown" && s.state === "on";
      }).length
    : null;

  return (
    <SettingsSection
      title="Integrations"
      description={
        // No "of N": LinkedIn is a CSV upload with nothing to connect, so N was never reachable.
        connected
          ? `${connected} connected. AI keys, outreach, your calendar feed, the API — and contact imports.`
          : "AI keys, outreach, your calendar feed, the API — and contact imports."
      }
      action={
        <Button size="sm" variant="outline" onClick={() => openOn()}>
          Manage
        </Button>
      }
    >
      {groups.map((group) => (
        <div key={group.key} className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{group.label}</p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {group.tabs.map((t) => {
              const Icon = INTEGRATION_ICONS[t.id];
              const status = statuses?.[t.id];
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => openOn(t.id)}
                    className={cn(
                      "group/row flex w-full items-center gap-3 rounded-xl border border-border/60 px-3 py-2.5 text-left",
                      "outline-none transition-colors duration-fast ease-house",
                      "hover:border-border hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/70"
                    )}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground transition-colors group-hover/row:text-primary">
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">
                        {t.label}
                      </span>
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <StatusDot status={status} />
                        <span className="truncate">{statusText(status)}</span>
                      </span>
                    </span>
                    <ChevronRight
                      aria-hidden
                      className="size-4 shrink-0 text-muted-foreground/50 transition-transform duration-fast ease-house group-hover/row:translate-x-0.5"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      <IntegrationsDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) return;
          // Strip first, so the refresh below is queued behind the restore, not dropped by it.
          clearDeepLink();
          // Whatever was connected, saved or revoked in there should show on the card.
          refreshStatuses();
        }}
        tab={tab}
        onTabChange={setTab}
        tabs={tabs}
        statuses={statuses}
        initialSettings={initialSettings}
        canUseRecruiters={canUseRecruiters}
      />
    </SettingsSection>
  );
}
