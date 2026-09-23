"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ChevronRight } from "lucide-react";
import type { getSettings } from "@/actions/settings";
import { getIntegrationStatuses } from "@/actions/integrations";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/components/settings/settings-section";
import {
  INTEGRATION_PARAM,
  OVERVIEW,
  OVERVIEW_TABS,
  integrationLabel,
  isAdvancedIntegrationTab,
  legacyHashTab,
  resolveIntegrationParam,
  type IntegrationFocus,
  type IntegrationTabId,
  type IntegrationView,
} from "@/components/settings/sections";
import { IntegrationIcon, StatusDot, statusText } from "@/components/settings/integration-ui";
import { IntegrationsDialog, tabForImportJob } from "@/components/settings/integrations-dialog";
import { useImportJob } from "@/lib/import-job-runner";
import type { IntegrationStatuses } from "@/lib/integration-status";
import { cn } from "@/lib/utils";

type Settings = Awaited<ReturnType<typeof getSettings>>;

/**
 * The Integrations group's one card: each account at a glance, and the way into the dialog
 * where it is set up.
 *
 * Opened by Manage or a row, or by either of two links, each of which has to land on the
 * right page:
 *   - `?integration=<page>` — the link every other part of the app uses (`integrationHref`),
 *     and the `returnTo` a Google or Microsoft consent screen sends the user back to. Old ids
 *     (`gmail`, `outlook`, `calendar`) still resolve, `gmail` to the Google page's inbox;
 *   - `#settings-ai` and the other anchors these pages had when they were cards on the page.
 * Manage opens on the Overview, or on an importer's page while its import job is running —
 * a running job never opens the dialog by itself.
 */
export function IntegrationsSettings({
  tabs,
  inboxVisible,
  initialSettings,
  canUseRecruiters,
}: {
  /** Visible pages, in order — hidden surfaces already filtered out by the page. */
  tabs: IntegrationTabId[];
  /** False when /recruiters is hidden — both account pages drop their inbox row. */
  inboxVisible: boolean;
  initialSettings: Settings;
  canUseRecruiters: boolean;
}) {
  const searchParams = useSearchParams();
  const job = useImportJob();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<IntegrationView>(OVERVIEW);
  const [focus, setFocus] = useState<IntegrationFocus | null>(null);
  const [statuses, setStatuses] = useState<IntegrationStatuses | null>(null);
  // The dialog's Advanced disclosure. It lives out here because opening it is part of
  // arriving at an Advanced page from a link, and links are read here — `selectView` below is
  // the one door every page goes through that isn't the dialog's own nav. Inside the dialog
  // nothing re-opens it, so a collapse made there stays made.
  const [advancedOpen, setAdvancedOpen] = useState(false);

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

  const rows = OVERVIEW_TABS.filter((id) => tabs.includes(id));

  /**
   * Selecting a page: an Advanced one opens the Advanced block on its way in, so the page the
   * dialog lands on has a row in the nav rather than one folded away out of sight.
   */
  const selectView = useCallback((next: IntegrationView) => {
    setView(next);
    if (isAdvancedIntegrationTab(next)) setAdvancedOpen(true);
  }, []);

  /** Opens on `next` when this viewer can see it; otherwise on the Overview. */
  const show = useCallback(
    (next: IntegrationView, nextFocus: IntegrationFocus | null = null) => {
      const visible = next === OVERVIEW || tabs.includes(next);
      selectView(visible ? next : OVERVIEW);
      setFocus(visible ? nextFocus : null);
      setOpen(true);
    },
    [tabs, selectView]
  );

  const openOn = useCallback(
    (next?: IntegrationTabId) => {
      const running = job?.status === "running" ? tabForImportJob(job.kind) : null;
      // With only Advanced pages visible the Overview would be empty, so start on a page.
      const home: IntegrationView = rows.length > 0 ? OVERVIEW : (tabs[0] ?? OVERVIEW);
      show(next ?? (running && tabs.includes(running) ? running : home));
    },
    [job, tabs, rows.length, show]
  );

  // `?integration=` — read through `useSearchParams` so a link clicked while already on
  // Settings (the notifications panel is reachable from here) opens the dialog without a
  // remount. Opened while rendering rather than in an effect, so the dialog is up in the
  // same paint the URL asks for it; `handled` makes each request count once.
  const requested = searchParams.get(INTEGRATION_PARAM);
  const [handled, setHandled] = useState<string | null>(null);
  if (requested !== handled) {
    setHandled(requested);
    const resolved = resolveIntegrationParam(requested);
    if (resolved && (resolved.view === OVERVIEW || tabs.includes(resolved.view))) {
      selectView(resolved.view);
      setFocus(resolved.focus);
      setOpen(true);
    }
  }

  // The old per-card anchors. Each hash is acted on once, which the ref — not the effect's
  // deps — is what guarantees: `tabs` is a fresh array after every `router.refresh()`, and
  // `show` is rebuilt with it, so a save that refreshes the server data re-runs this effect.
  // Without the ref that re-run re-read the hash still sitting in the URL and threw the person
  // back to the page it names, in the middle of whatever they had moved on to.
  const handledHash = useRef<string | null>(null);
  useEffect(() => {
    function openForHash() {
      const hash = window.location.hash;
      if (hash === handledHash.current) return;
      const target = legacyHashTab(hash);
      // Only an acted-on hash counts as spent. A hash naming a page this viewer cannot yet
      // see must stay available — a later `router.refresh()` that widens `tabs` re-runs this
      // effect, and if it were marked handled here regardless, that widening would find the
      // hash already spent and never open the page it now names.
      if (target && tabs.includes(target)) {
        handledHash.current = hash;
        show(target);
      }
    }
    openForHash();
    window.addEventListener("hashchange", openForHash);
    return () => window.removeEventListener("hashchange", openForHash);
  }, [tabs, show]);

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
    const legacyHash = legacyHashTab(window.location.hash);
    if (!hadParam && !legacyHash) return;
    const rest = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${rest ? `?${rest}` : ""}${legacyHash ? "" : window.location.hash}`
    );
    // `replaceState` fires no `hashchange`, so the guard above has to be told the hash is
    // gone. Left holding a hash the URL no longer has, it would ignore the same anchor the
    // next time someone clicked it.
    handledHash.current = window.location.hash;
  }

  if (tabs.length === 0) return null;

  const connected = statuses
    ? rows.filter((id) => {
        const s = statuses.pages[id];
        return s !== undefined && s !== "unknown" && s.state === "on";
      }).length
    : null;

  return (
    <SettingsSection
      title="Integrations"
      description={
        connected
          ? `${connected} set up. Connect the accounts Orbit works with.`
          : "Connect the accounts Orbit works with."
      }
      action={
        <Button size="sm" variant="outline" onClick={() => openOn()}>
          Manage
        </Button>
      }
    >
      {rows.length > 0 ? (
        <ul className="grid gap-2 sm:grid-cols-2">
          {rows.map((id) => {
            const status = statuses?.pages[id];
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => openOn(id)}
                  className={cn(
                    "group/row flex w-full items-center gap-3 rounded-xl border border-border/60 px-3 py-2.5 text-left",
                    "outline-none transition-colors duration-fast ease-house",
                    "hover:border-border hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/70"
                  )}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground transition-colors group-hover/row:text-primary">
                    <IntegrationIcon id={id} className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">
                      {integrationLabel(id)}
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
      ) : null}

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
        view={view}
        advancedOpen={advancedOpen}
        onAdvancedOpenChange={setAdvancedOpen}
        onViewChange={(next) => {
          // Back on the Overview after a page: show what was just turned on or connected
          // there, not what was true when the dialog opened.
          if (next === OVERVIEW && view !== OVERVIEW) refreshStatuses();
          selectView(next);
          setFocus(null);
        }}
        focus={focus}
        tabs={tabs}
        statuses={statuses}
        inboxVisible={inboxVisible}
        initialSettings={initialSettings}
        canUseRecruiters={canUseRecruiters}
      />
    </SettingsSection>
  );
}
