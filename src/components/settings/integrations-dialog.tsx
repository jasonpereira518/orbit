"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { LucideIcon } from "lucide-react";
import {
  BookUser,
  CalendarDays,
  FileSpreadsheet,
  KeyRound,
  MailSearch,
  Send,
  Sparkles,
  Users,
  Webhook,
} from "lucide-react";
import type { getSettings } from "@/actions/settings";
import type { IntegrationStatus, IntegrationStatuses } from "@/actions/integrations";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { AiSettings } from "@/components/settings/ai-settings";
import { OutreachSettings } from "@/components/settings/outreach-settings";
import { CalendarFeedSettings } from "@/components/settings/calendar-feed-settings";
import { ApiSettings } from "@/components/settings/api-settings";
import { WebhookSettings } from "@/components/settings/webhook-settings";
import { SettingsSurfaceProvider } from "@/components/settings/settings-section";
import {
  INTEGRATION_TAB_GROUPS,
  INTEGRATION_TABS,
  integrationHref,
  type IntegrationTabId,
} from "@/components/settings/sections";
import { ImportProgress } from "@/components/imports/import-utils";
import {
  cancelImportJob,
  useImportJob,
  type ImportJobKind,
} from "@/lib/import-job-runner";
import { cn } from "@/lib/utils";

type Settings = Awaited<ReturnType<typeof getSettings>>;

export const INTEGRATION_ICONS: Record<IntegrationTabId, LucideIcon> = {
  ai: Sparkles,
  outreach: Send,
  calendar: CalendarDays,
  api: KeyRound,
  webhooks: Webhook,
  google: Users,
  linkedin: FileSpreadsheet,
  outlook: BookUser,
  gmail: MailSearch,
};

/**
 * The importer tab an in-flight import job belongs to. The calendar-file and contacts-file
 * imports live only on /imports, so they have none.
 */
export function tabForImportJob(kind: ImportJobKind): IntegrationTabId | null {
  switch (kind) {
    case "connections":
    case "messages":
      return "linkedin";
    case "google_contacts":
      return "google";
    case "outlook_contacts":
      return "outlook";
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
// visits never open them, so they load on first open of their tab, as on /imports.
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

export function StatusDot({
  status,
  className,
}: {
  status: IntegrationStatus | "unknown" | undefined;
  className?: string;
}) {
  if (status === undefined) {
    return (
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 animate-pulse rounded-full bg-muted-foreground/30", className)}
      />
    );
  }
  const state = status === "unknown" ? "off" : status.state;
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        state === "on" && "bg-primary",
        state === "partial" && "bg-warning",
        state === "off" && "bg-muted-foreground/35",
        className
      )}
    />
  );
}

export function statusText(status: IntegrationStatus | "unknown" | undefined) {
  if (status === undefined) return "Checking…";
  if (status === "unknown") return "Couldn’t check";
  return status.detail;
}

const MD_QUERY = "(min-width: 768px)";

/** Side nav on `md`+, a horizontal strip below it — `aria-orientation` has to say which. */
function useIsWide() {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(MD_QUERY);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(MD_QUERY).matches,
    () => true
  );
}

/**
 * Settings → Integrations: every key, feed, API and importer behind one card, in a dialog
 * with a vertical side nav.
 *
 * Panels mount the first time their tab opens and then stay mounted (hidden) for as long as
 * the dialog is open — the same rule as /imports — so a half-reviewed Google import or an
 * API key still waiting to be copied survives a detour to another tab. Import jobs outlive
 * the dialog altogether: the job runner is a module singleton, and the app shell's watcher
 * and progress bar keep reporting after it closes.
 */
export function IntegrationsDialog({
  open,
  onOpenChange,
  tab,
  onTabChange,
  tabs,
  statuses,
  initialSettings,
  canUseRecruiters,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tab: IntegrationTabId;
  onTabChange: (tab: IntegrationTabId) => void;
  /** The tabs this viewer may see, in order — already filtered for hidden surfaces. */
  tabs: IntegrationTabId[];
  statuses: IntegrationStatuses | null;
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
          tab={tab}
          onTabChange={onTabChange}
          tabs={tabs}
          statuses={statuses}
          initialSettings={initialSettings}
          canUseRecruiters={canUseRecruiters}
        />
      </DialogContent>
    </Dialog>
  );
}

function DialogBody({
  active,
  tab,
  onTabChange,
  tabs,
  statuses,
  initialSettings,
  canUseRecruiters,
}: {
  /**
   * False from the moment the dialog starts closing. Base UI only unmounts the body once
   * its exit animation ends — which a backgrounded tab never finishes — so anything that
   * polls has to stop on this, not on unmount.
   */
  active: boolean;
  tab: IntegrationTabId;
  onTabChange: (tab: IntegrationTabId) => void;
  tabs: IntegrationTabId[];
  statuses: IntegrationStatuses | null;
  initialSettings: Settings;
  canUseRecruiters: boolean;
}) {
  const wide = useIsWide();
  const job = useImportJob();
  const [visited, setVisited] = useState<ReadonlySet<IntegrationTabId>>(() => new Set([tab]));
  const tabRefs = useRef(new Map<IntegrationTabId, HTMLButtonElement>());
  const panelScroller = useRef<HTMLDivElement>(null);

  // Adjusting state during render rather than in an effect: a tab chosen from outside (a
  // deep link, the card) must be mounted in the same paint it is shown in.
  if (!visited.has(tab)) setVisited(new Set(visited).add(tab));

  // Each tab starts at its own top rather than wherever the last one was scrolled to, and
  // its nav entry is brought into view — on a phone the strip scrolls sideways, and a tab
  // opened by a deep link can otherwise sit off its right edge.
  useEffect(() => {
    panelScroller.current?.scrollTo({ top: 0 });
    tabRefs.current.get(tab)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);

  const runningTab =
    job?.status === "running" ? tabForImportJob(job.kind) : null;
  const runningProgress =
    job?.status === "running" && job.progress ? job.progress : null;

  const groups = INTEGRATION_TAB_GROUPS.map((group) => ({
    ...group,
    tabs: INTEGRATION_TABS.filter((t) => t.group === group.key && tabs.includes(t.id)),
  })).filter((group) => group.tabs.length > 0);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const index = tabs.indexOf(tab);
    let next: number;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        next = (index + 1) % tabs.length;
        break;
      case "ArrowUp":
      case "ArrowLeft":
        next = (index - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const id = tabs[next];
    onTabChange(id);
    tabRefs.current.get(id)?.focus();
  }

  return (
    <>
      <aside className="flex min-h-0 shrink-0 flex-col border-b border-border/60 bg-muted/30 md:border-r md:border-b-0">
        <div className="px-4 pt-4 pb-3 pr-12 md:px-5 md:pt-5 md:pr-5">
          <DialogTitle className="font-[family-name:var(--font-display)] text-xl text-ink">
            Integrations
          </DialogTitle>
          <DialogDescription className="mt-1.5 text-xs">
            Keys, feeds and imports that connect Orbit to the rest of your tools.
          </DialogDescription>
        </div>
        <div
          role="tablist"
          aria-label="Integrations"
          aria-orientation={wide ? "vertical" : "horizontal"}
          onKeyDown={onKeyDown}
          className="flex gap-1 overflow-x-auto px-3 pb-3 [scrollbar-width:none] md:min-h-0 md:flex-1 md:flex-col md:overflow-x-visible md:overflow-y-auto md:pb-4 [&::-webkit-scrollbar]:hidden"
        >
          {groups.map((group) => (
            <div key={group.key} className="contents md:block">
              <p
                aria-hidden
                className="hidden px-2.5 pt-3 pb-1.5 text-[0.6875rem] font-semibold tracking-[0.08em] text-muted-foreground/80 uppercase md:block"
              >
                {group.label}
              </p>
              {group.tabs.map((t) => {
                const Icon = INTEGRATION_ICONS[t.id];
                const selected = t.id === tab;
                const status = statuses?.[t.id];
                return (
                  <button
                    key={t.id}
                    ref={(el) => {
                      if (el) tabRefs.current.set(t.id, el);
                      else tabRefs.current.delete(t.id);
                    }}
                    type="button"
                    role="tab"
                    id={`integration-tab-${t.id}`}
                    aria-selected={selected}
                    aria-controls={`integration-panel-${t.id}`}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => onTabChange(t.id)}
                    className={cn(
                      "flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm whitespace-nowrap md:w-full",
                      "outline-none transition-colors duration-fast ease-house focus-visible:ring-2 focus-visible:ring-ring/70",
                      selected
                        ? "bg-card text-ink shadow-sm ring-1 ring-border/70"
                        : "text-muted-foreground hover:bg-card/60 hover:text-foreground"
                    )}
                  >
                    <Icon
                      aria-hidden
                      className={cn("size-4 shrink-0", selected ? "text-primary" : "opacity-80")}
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {t.label}
                      {runningTab === t.id ? (
                        <span className="text-muted-foreground"> · running</span>
                      ) : null}
                    </span>
                    <StatusDot status={status} className="hidden md:block" />
                    <span className="sr-only">, {statusText(status)}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </aside>

      <div ref={panelScroller} className="min-h-0 flex-1 overflow-y-auto">
        <SettingsSurfaceProvider surface="panel">
          {tabs.map((id) =>
            visited.has(id) ? (
              <div
                key={id}
                role="tabpanel"
                id={`integration-panel-${id}`}
                aria-labelledby={`integration-tab-${id}`}
                hidden={id !== tab}
                className="space-y-5 p-5 md:p-7"
              >
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
                  initialSettings={initialSettings}
                  canUseRecruiters={canUseRecruiters}
                />
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
  initialSettings,
  canUseRecruiters,
}: {
  id: IntegrationTabId;
  active: boolean;
  initialSettings: Settings;
  canUseRecruiters: boolean;
}) {
  switch (id) {
    case "ai":
      return <AiSettings initialSettings={initialSettings} />;
    case "outreach":
      return <OutreachSettings initial={initialSettings.outreach} />;
    case "calendar":
      return <CalendarFeedSettings />;
    case "api":
      return <ApiSettings />;
    case "webhooks":
      return <WebhookSettings />;
    case "google":
      return <GoogleContactsImport returnTo={integrationHref("google")} />;
    case "outlook":
      return <OutlookContactsImport returnTo={integrationHref("outlook")} />;
    case "linkedin":
      return (
        <div className="space-y-5">
          <LinkedInConnectionsImport />
          <LinkedInMessagesImport />
        </div>
      );
    case "gmail":
      return (
        <GmailTab
          active={active}
          canUseRecruiters={canUseRecruiters}
          returnTo={integrationHref("gmail")}
        />
      );
  }
}
