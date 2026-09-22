"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, LayoutGrid } from "lucide-react";
import type { getSettings } from "@/actions/settings";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { AiSettings } from "@/components/settings/ai-settings";
import { DecisionModelSettings } from "@/components/settings/decision-model-settings";
import { AiUsageCard } from "@/components/settings/ai-usage-card";
import { ApiSettings } from "@/components/settings/api-settings";
import { AssistantsSettings } from "@/components/settings/assistants-settings";
import { CalendarFeedSettings } from "@/components/settings/calendar-feed-settings";
import { IntegrationIcon, StatusDot, statusText } from "@/components/settings/integration-ui";
import { IntegrationsOverview } from "@/components/settings/integrations-overview";
import { OutreachSettings } from "@/components/settings/outreach-settings";
import { SettingsSurfaceProvider } from "@/components/settings/settings-section";
import { WebhookSettings } from "@/components/settings/webhook-settings";
import {
  INTEGRATION_TAB_GROUPS,
  INTEGRATION_TABS,
  OVERVIEW,
  integrationHref,
  type IntegrationFocus,
  type IntegrationTabId,
  type IntegrationView,
} from "@/components/settings/sections";
import { ImportProgress } from "@/components/imports/import-utils";
import {
  cancelImportJob,
  useImportJob,
  type ImportJobKind,
} from "@/lib/import-job-runner";
import type { IntegrationStatuses } from "@/lib/integration-status";
import { cn } from "@/lib/utils";

type Settings = Awaited<ReturnType<typeof getSettings>>;

/**
 * The page an in-flight import job belongs to. The calendar-file and contacts-file imports
 * live only on /imports, so they have none.
 */
export function tabForImportJob(kind: ImportJobKind): IntegrationTabId | null {
  switch (kind) {
    case "connections":
    case "messages":
      return "linkedin";
    case "google_contacts":
      return "google";
    case "outlook_contacts":
      return "microsoft";
    case "contacts_file":
    case "calendar":
      return null;
  }
}

const PanelSkeleton = () => (
  <div className="space-y-3" aria-busy="true" aria-label="Loading">
    <Skeleton className="h-6 w-44" />
    <Skeleton className="h-4 w-3/4" />
    <Skeleton className="h-28 w-full rounded-xl" />
    <Skeleton className="h-9 w-36 rounded-lg" />
  </div>
);

// The importers are the heavy half of this dialog — CSV parsing, review tables — and most
// visits never open them, so they load on first open of their page, as on /imports.
const GoogleContactsImport = dynamic(
  () =>
    import("@/components/imports/google-contacts-import").then((m) => ({
      default: m.GoogleContactsImport,
    })),
  { loading: () => <PanelSkeleton /> }
);
const OutlookContactsImport = dynamic(
  () =>
    import("@/components/imports/outlook-contacts-import").then((m) => ({
      default: m.OutlookContactsImport,
    })),
  { loading: () => <PanelSkeleton /> }
);
const LinkedInConnectionsImport = dynamic(
  () =>
    import("@/components/imports/linkedin-connections-import").then((m) => ({
      default: m.LinkedInConnectionsImport,
    })),
  { loading: () => <PanelSkeleton /> }
);
const LinkedInMessagesImport = dynamic(
  () =>
    import("@/components/imports/linkedin-messages-import").then((m) => ({
      default: m.LinkedInMessagesImport,
    })),
  { loading: () => <PanelSkeleton /> }
);
const GmailTab = dynamic(
  () =>
    import("@/components/settings/integrations-gmail-tab").then((m) => ({
      default: m.GmailTab,
    })),
  { loading: () => <PanelSkeleton /> }
);

function isAdvanced(view: IntegrationView): boolean {
  return INTEGRATION_TABS.some((tab) => tab.id === view && tab.group === "advanced");
}

/** The element a `focus` lands on, e.g. `integration-google-inbox`. */
function focusTargetId(view: IntegrationView, focus: IntegrationFocus) {
  return `integration-${view}-${focus}`;
}

/**
 * Settings → Integrations: the accounts Orbit works with, one page each, with the developer
 * tools folded into Advanced.
 *
 * Pages mount the first time they open and then stay mounted (hidden) for as long as the
 * dialog is open — the same rule as /imports — so a half-reviewed Google import or an API key
 * still waiting to be copied survives a detour to another page. Import jobs outlive the
 * dialog altogether: the job runner is a module singleton, and the app shell's watcher and
 * progress bar keep reporting after it closes.
 */
export function IntegrationsDialog({
  open,
  onOpenChange,
  view,
  onViewChange,
  focus,
  tabs,
  statuses,
  inboxVisible,
  initialSettings,
  canUseRecruiters,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: IntegrationView;
  onViewChange: (view: IntegrationView) => void;
  /** Where inside `view` to land — set by links like `?integration=gmail`. */
  focus: IntegrationFocus | null;
  /** The pages this viewer may see, in order — already filtered for hidden surfaces. */
  tabs: IntegrationTabId[];
  statuses: IntegrationStatuses | null;
  /** False when /recruiters is hidden: the Google page then leaves out its Gmail inbox block. */
  inboxVisible: boolean;
  initialSettings: Settings;
  canUseRecruiters: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "flex h-[min(88dvh,46rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl",
          "md:grid md:grid-cols-[14.5rem_minmax(0,1fr)]"
        )}
      >
        <DialogBody
          active={open}
          view={view}
          onViewChange={onViewChange}
          focus={focus}
          tabs={tabs}
          statuses={statuses}
          inboxVisible={inboxVisible}
          initialSettings={initialSettings}
          canUseRecruiters={canUseRecruiters}
        />
      </DialogContent>
    </Dialog>
  );
}

function DialogBody({
  active,
  view,
  onViewChange,
  focus,
  tabs,
  statuses,
  inboxVisible,
  initialSettings,
  canUseRecruiters,
}: {
  /**
   * False from the moment the dialog starts closing. Base UI only unmounts the body once
   * its exit animation ends — which a backgrounded tab never finishes — so anything that
   * polls has to stop on this, not on unmount.
   */
  active: boolean;
  view: IntegrationView;
  onViewChange: (view: IntegrationView) => void;
  focus: IntegrationFocus | null;
  tabs: IntegrationTabId[];
  statuses: IntegrationStatuses | null;
  inboxVisible: boolean;
  initialSettings: Settings;
  canUseRecruiters: boolean;
}) {
  const job = useImportJob();
  const [visited, setVisited] = useState<ReadonlySet<IntegrationView>>(() => new Set([view]));
  const [advancedOpen, setAdvancedOpen] = useState(() => isAdvanced(view));
  const tabRefs = useRef(new Map<IntegrationView, HTMLButtonElement>());
  const panelScroller = useRef<HTMLDivElement>(null);
  // Where focus goes after the next view change, set only by changes that hide or remove the
  // control that made them: an Overview button sends focus into the page it opens, and the
  // phone's Back returns it to the Overview button for the page it leaves. The side nav never
  // sets it, so its tabs keep focus.
  const focusAfterViewChange = useRef<
    { to: "panel" } | { to: "opener"; of: IntegrationTabId } | null
  >(null);

  // Adjusted during render rather than in an effect: a page chosen from outside (a deep
  // link, the card) must be mounted — and its nav row shown — in the same paint it is
  // selected in.
  if (!visited.has(view)) setVisited(new Set(visited).add(view));
  if (isAdvanced(view) && !advancedOpen) setAdvancedOpen(true);

  // Each page starts at its own top (or at the spot a link asked for) rather than wherever
  // the last one was scrolled to, and its nav row is brought into view.
  useEffect(() => {
    const target = focus ? document.getElementById(focusTargetId(view, focus)) : null;
    if (target) target.scrollIntoView({ block: "start" });
    else panelScroller.current?.scrollTo({ top: 0 });
    tabRefs.current.get(view)?.scrollIntoView({ block: "nearest" });
    if (!target) return;

    // The page's importers are still loading skeletons on this first scroll, and push the
    // target down once they resolve — keep re-scrolling to it until the panel stops resizing,
    // the person takes over, or 3s pass.
    const scroller = panelScroller.current;
    let stopped = false;
    let observer: ResizeObserver | undefined;

    function stop() {
      if (stopped) return;
      stopped = true;
      observer?.disconnect();
      clearTimeout(timer);
      scroller?.removeEventListener("wheel", stop);
      scroller?.removeEventListener("touchstart", stop);
      scroller?.removeEventListener("pointerdown", stop);
      scroller?.removeEventListener("keydown", stop);
    }

    scroller?.addEventListener("wheel", stop, { passive: true });
    scroller?.addEventListener("touchstart", stop, { passive: true });
    scroller?.addEventListener("pointerdown", stop);
    scroller?.addEventListener("keydown", stop);
    const timer = setTimeout(stop, 3_000);

    if (typeof ResizeObserver !== "undefined") {
      const panel = target.closest('[role="tabpanel"]');
      if (panel) {
        observer = new ResizeObserver(() => {
          if (!stopped) target.scrollIntoView({ block: "start" });
        });
        observer.observe(panel);
      }
    }

    return stop;
  }, [view, focus]);

  // After the scroll above, so the page is already where it should be. The panel is named by
  // its nav row. An opener can be out of reach — an Advanced page reached by a link leaves its
  // row in a collapsed block — so the Overview itself takes focus when the opener didn't.
  useEffect(() => {
    const request = focusAfterViewChange.current;
    focusAfterViewChange.current = null;
    if (!request) return;
    const panel = document.getElementById(`integration-panel-${view}`);
    if (request.to === "opener") {
      const opener = panel?.querySelector<HTMLElement>(`[data-integration-card="${request.of}"]`);
      opener?.focus({ preventScroll: true });
      if (opener && document.activeElement === opener) {
        opener.scrollIntoView({ block: "nearest" });
        return;
      }
    }
    panel?.focus({ preventScroll: true });
  }, [view]);

  /** A page opened from the Overview's own buttons, which the Overview then hides. */
  function openFromOverview(tab: IntegrationTabId) {
    if (tab !== view) focusAfterViewChange.current = { to: "panel" };
    onViewChange(tab);
  }

  function backToOverview() {
    if (view !== OVERVIEW) focusAfterViewChange.current = { to: "opener", of: view };
    onViewChange(OVERVIEW);
  }

  const runningTab = job?.status === "running" ? tabForImportJob(job.kind) : null;
  const runningProgress = job?.status === "running" && job.progress ? job.progress : null;

  const visibleTabs = INTEGRATION_TABS.filter((tab) => tabs.includes(tab.id));
  const mainGroups = INTEGRATION_TAB_GROUPS.filter((group) => group.key !== "advanced")
    .map((group) => ({ ...group, tabs: visibleTabs.filter((tab) => tab.group === group.key) }))
    .filter((group) => group.tabs.length > 0);
  const advancedTabs = visibleTabs.filter((tab) => tab.group === "advanced");
  const mainIds: IntegrationView[] = [OVERVIEW, ...mainGroups.flatMap((g) => g.tabs.map((t) => t.id))];
  const advancedIds: IntegrationView[] = advancedTabs.map((tab) => tab.id);
  const views: IntegrationView[] = [OVERVIEW, ...visibleTabs.map((tab) => tab.id)];

  function onTabKeyDown(event: React.KeyboardEvent<HTMLDivElement>, ids: IntegrationView[]) {
    const index = ids.indexOf(view);
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = index < 0 ? 0 : (index + 1) % ids.length;
        break;
      case "ArrowUp":
        next = index < 0 ? ids.length - 1 : (index - 1 + ids.length) % ids.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = ids.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const id = ids[next];
    onViewChange(id);
    tabRefs.current.get(id)?.focus();
  }

  function tabRow(id: IntegrationView, label: string, ids: IntegrationView[]) {
    const selected = id === view;
    // Roving tabindex per tablist: the selected row, or the first row when the selection
    // is in the other list.
    const tabbable = selected || (!ids.includes(view) && id === ids[0]);
    const status = id === OVERVIEW ? undefined : statuses?.pages[id];
    const iconClass = cn("size-4 shrink-0", selected ? "text-primary" : "opacity-80");
    return (
      <button
        key={id}
        ref={(el) => {
          if (el) tabRefs.current.set(id, el);
          else tabRefs.current.delete(id);
        }}
        type="button"
        role="tab"
        id={`integration-tab-${id}`}
        aria-selected={selected}
        aria-controls={`integration-panel-${id}`}
        tabIndex={tabbable ? 0 : -1}
        onClick={() => onViewChange(id)}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm whitespace-nowrap",
          "outline-none transition-colors duration-fast ease-house focus-visible:ring-2 focus-visible:ring-ring/70",
          selected
            ? "bg-card text-ink shadow-sm ring-1 ring-border/70"
            : "text-muted-foreground hover:bg-card/60 hover:text-foreground"
        )}
      >
        {id === OVERVIEW ? (
          <LayoutGrid aria-hidden className={iconClass} />
        ) : (
          <IntegrationIcon id={id} className={iconClass} />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">
          {label}
          {runningTab === id ? <span className="text-muted-foreground"> · running</span> : null}
        </span>
        {id === OVERVIEW ? null : (
          <>
            <StatusDot status={status} />
            <span className="sr-only">, {statusText(status)}</span>
          </>
        )}
      </button>
    );
  }

  return (
    <>
      <aside className="flex shrink-0 flex-col border-b border-border/60 bg-muted/30 md:min-h-0 md:border-r md:border-b-0">
        <div className="flex items-center gap-1.5 px-4 pt-4 pb-3 pr-12 md:block md:px-5 md:pt-5 md:pr-5">
          {view !== OVERVIEW ? (
            <button
              type="button"
              onClick={backToOverview}
              aria-label="Back to overview"
              className="tap-target -ml-1.5 flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-card/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70 md:hidden"
            >
              <ChevronLeft aria-hidden className="size-5" />
            </button>
          ) : null}
          <div className="min-w-0">
            <DialogTitle className="font-[family-name:var(--font-display)] text-xl text-ink">
              Integrations
            </DialogTitle>
            <DialogDescription className="mt-1.5 hidden text-xs md:block">
              Connect the accounts Orbit works with.
            </DialogDescription>
          </div>
        </div>

        <nav
          aria-label="Integrations"
          className="hidden min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-4 md:flex"
        >
          <div
            role="tablist"
            aria-label="Integrations"
            aria-orientation="vertical"
            onKeyDown={(event) => onTabKeyDown(event, mainIds)}
          >
            {tabRow(OVERVIEW, "Overview", mainIds)}
            {mainGroups.map((group) => (
              <div key={group.key}>
                <p
                  aria-hidden
                  className="px-2.5 pt-3 pb-1.5 text-[0.6875rem] font-semibold tracking-[0.08em] text-muted-foreground/80 uppercase"
                >
                  {group.label}
                </p>
                {group.tabs.map((tab) => tabRow(tab.id, tab.label, mainIds))}
              </div>
            ))}
          </div>

          {advancedTabs.length > 0 ? (
            <div className="mt-3 border-t border-border/60 pt-2">
              <button
                type="button"
                aria-expanded={advancedOpen}
                aria-controls="integration-advanced-tabs"
                onClick={() => setAdvancedOpen((wasOpen) => !wasOpen)}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground outline-none hover:bg-card/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/70"
              >
                <ChevronRight
                  aria-hidden
                  className={cn(
                    "size-4 shrink-0 transition-transform duration-fast ease-house",
                    advancedOpen && "rotate-90"
                  )}
                />
                Advanced
              </button>
              {advancedOpen ? (
                <div
                  id="integration-advanced-tabs"
                  role="tablist"
                  aria-label="Advanced"
                  aria-orientation="vertical"
                  onKeyDown={(event) => onTabKeyDown(event, advancedIds)}
                >
                  {advancedTabs.map((tab) => tabRow(tab.id, tab.label, advancedIds))}
                </div>
              ) : null}
            </div>
          ) : null}
        </nav>
      </aside>

      <div ref={panelScroller} className="min-h-0 flex-1 overflow-y-auto">
        <SettingsSurfaceProvider surface="panel">
          {views.map((id) =>
            visited.has(id) ? (
              <div
                key={id}
                role="tabpanel"
                id={`integration-panel-${id}`}
                aria-labelledby={`integration-tab-${id}`}
                tabIndex={-1}
                hidden={id !== view}
                className="space-y-5 p-5 outline-none md:p-7"
              >
                {id === OVERVIEW ? (
                  <IntegrationsOverview tabs={tabs} statuses={statuses} onOpen={openFromOverview} />
                ) : (
                  <>
                    {runningProgress && runningTab === id ? (
                      <ImportProgress
                        {...runningProgress}
                        cancelling={Boolean(job?.cancelling)}
                        onCancel={cancelImportJob}
                      />
                    ) : null}
                    <Panel
                      id={id}
                      active={active}
                      inboxVisible={inboxVisible}
                      initialSettings={initialSettings}
                      canUseRecruiters={canUseRecruiters}
                    />
                  </>
                )}
              </div>
            ) : null
          )}
        </SettingsSurfaceProvider>
      </div>
    </>
  );
}

function Panel({
  id,
  active,
  inboxVisible,
  initialSettings,
  canUseRecruiters,
}: {
  id: IntegrationTabId;
  active: boolean;
  inboxVisible: boolean;
  initialSettings: Settings;
  canUseRecruiters: boolean;
}) {
  switch (id) {
    case "google":
      return (
        <div className="space-y-5">
          <GoogleContactsImport returnTo={integrationHref("google")} />
          {inboxVisible ? (
            <div id={focusTargetId("google", "inbox")} className="scroll-mt-4">
              <GmailTab active={active} canUseRecruiters={canUseRecruiters} returnTo={integrationHref("gmail")} />
            </div>
          ) : null}
        </div>
      );
    case "microsoft":
      return <OutlookContactsImport returnTo={integrationHref("microsoft")} />;
    case "linkedin":
      return (
        <div className="space-y-5">
          <LinkedInConnectionsImport />
          <LinkedInMessagesImport />
        </div>
      );
    case "ai":
      return (
        <div className="space-y-5">
          <AiSettings initialSettings={initialSettings} />
          <DecisionModelSettings initialSettings={initialSettings} />
          <AiUsageCard />
        </div>
      );
    case "assistants":
      return <AssistantsSettings />;
    case "reminders":
      return <CalendarFeedSettings />;
    case "api":
      return <ApiSettings />;
    case "webhooks":
      return <WebhookSettings />;
    case "outreach":
      return <OutreachSettings initial={initialSettings.outreach} />;
  }
}
