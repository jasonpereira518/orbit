"use client";

import { useState } from "react";
import { ChevronRight, LayoutGrid, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IntegrationIcon, StatusDot, statusText } from "@/components/settings/integration-ui";
import {
  INTEGRATION_TABS,
  OVERVIEW_TABS,
  integrationLabel,
  type IntegrationTabId,
} from "@/components/settings/sections";
import {
  overviewAction,
  type AccountProvider,
  type IntegrationStatuses,
} from "@/lib/integration-status";
import { cn } from "@/lib/utils";

const DESCRIPTIONS: Partial<Record<IntegrationTabId, string>> = {
  google: "Contacts, calendar and Gmail.",
  microsoft: "Outlook contacts, calendar and mail.",
  linkedin: "Your connections, messages and profile.",
  ai: "Turns your notes into contacts and answers questions about your network.",
  assistants: "Use Orbit from inside Claude or ChatGPT.",
  reminders: "See your follow-ups next to your meetings.",
};

/**
 * The Integrations dialog's home: anything that needs fixing, then one card per integration
 * that is actually on — connected, or connected and asking for something. Everything else,
 * including what isn't set up yet, lives on the All connectors page this links to.
 * Advanced pages get no card — on wide screens they
 * are reachable from the nav, and on phones, where the nav is hidden, from a collapsed block
 * below the cards.
 *
 * The button that opens each page carries `data-integration-card`, so the dialog's phone Back
 * can return focus to it.
 *
 * One card button doesn't open its page: "Connect Google" / "Connect Microsoft"
 * (`overviewAction`'s `connects`) starts the consent screen from here, because opening the
 * page only to press Connect again is a step that says nothing. The consent screen still
 * comes back to that account's page — the dialog picks the `returnTo`.
 */
export function IntegrationsOverview({
  tabs,
  statuses,
  runningTab,
  onOpen,
  onConnect,
  connecting,
}: {
  /** Visible pages — hidden surfaces already filtered out. */
  tabs: IntegrationTabId[];
  statuses: IntegrationStatuses | null;
  /**
   * The page an import job is running on, or null. The nav row for it carries the same
   * marker, but the nav is hidden on phones — where this is the only thing on screen that
   * can say an import is under way.
   */
  runningTab: IntegrationTabId | null;
  onOpen: (tab: IntegrationTabId) => void;
  /** Starts that account's consent screen, for the cards whose action `connects`. */
  onConnect: (provider: AccountProvider) => void;
  /** The account whose consent screen is being asked for, so its button can disable until
   *  the browser leaves for the provider. Null when nothing is in flight. */
  connecting: AccountProvider | null;
}) {
  // On, or on and asking for something. Until the statuses arrive nothing is known to be on.
  const cards = OVERVIEW_TABS.filter((id) => {
    const status = statuses?.pages[id];
    return tabs.includes(id) && status !== undefined && status !== "unknown" && (status.state === "on" || status.state === "partial");
  });
  const showCatalogLink = tabs.includes("connectors");
  const attention = (statuses?.attention ?? []).filter((item) => tabs.includes(item.tab));
  const advancedTabs = INTEGRATION_TABS.filter((t) => t.group === "advanced" && tabs.includes(t.id));
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-medium text-ink">Overview</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          What Orbit is connected to right now.
        </p>
      </div>

      {attention.length > 0 ? (
        <ul aria-label="Needs your attention" className="space-y-2">
          {attention.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm"
            >
              <TriangleAlert aria-hidden className="size-4 shrink-0 text-warning" />
              <span className="min-w-0 flex-1 text-foreground">{item.message}</span>
              <Button size="sm" variant="outline" onClick={() => onOpen(item.tab)}>
                {item.action}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {statuses === null ? (
        <p className="text-sm text-muted-foreground">Checking your connections…</p>
      ) : cards.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing is connected yet.</p>
      ) : null}

      <ul className="grid gap-3 sm:grid-cols-2">
        {cards.map((id) => {
          const status = statuses?.pages[id];
          const account = id === "google" || id === "microsoft" ? statuses?.accounts[id] : undefined;
          const action = overviewAction(id, status, account);
          const showStatus = !(status && status !== "unknown" && status.state === "none");
          return (
            <li key={id} className="flex flex-col gap-3 rounded-xl border border-border/60 p-4">
              <div className="flex items-center gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/70">
                  <IntegrationIcon id={id} className="size-4" />
                </span>
                <h4 id={`integration-card-name-${id}`} className="text-sm font-medium text-ink">
                  {integrationLabel(id)}
                  {runningTab === id ? (
                    <span className="font-normal text-muted-foreground"> · running</span>
                  ) : null}
                </h4>
              </div>
              <p className="text-sm text-muted-foreground">{DESCRIPTIONS[id]}</p>
              {showStatus ? (
                <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <StatusDot status={status} />
                  <span className="truncate">{statusText(status)}</span>
                </p>
              ) : null}
              <div className="mt-auto">
                <Button
                  size="sm"
                  variant={action.primary ? "default" : "outline"}
                  data-integration-card={id}
                  // Sighted readers get the card around it; a screen reader announcing the
                  // buttons on their own would otherwise hear "Manage" four times over.
                  aria-describedby={`integration-card-name-${id}`}
                  disabled={action.connects ? connecting === action.connects : undefined}
                  onClick={() =>
                    action.connects ? onConnect(action.connects) : onOpen(id)
                  }
                >
                  {action.label}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      {showCatalogLink ? (
        <Button
          variant={cards.length === 0 ? "default" : "outline"}
          data-integration-card="connectors"
          onClick={() => onOpen("connectors")}
        >
          <LayoutGrid aria-hidden className="size-4" />
          {cards.length === 0 ? "Browse all connectors" : "See all connectors"}
        </Button>
      ) : null}

      {advancedTabs.length > 0 ? (
        <div className="border-t border-border/60 pt-4 md:hidden">
          <button
            type="button"
            aria-expanded={advancedOpen}
            aria-controls="integration-overview-advanced"
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
          <div id="integration-overview-advanced" hidden={!advancedOpen} className="space-y-1 pt-1">
            <p className="px-2.5 pb-2 text-xs text-muted-foreground">
              For developers and automation tools. You don’t need anything here to use Orbit.
            </p>
            {advancedTabs.map((tab) => {
              const status = statuses?.pages[tab.id];
              return (
                <button
                  key={tab.id}
                  type="button"
                  data-integration-card={tab.id}
                  onClick={() => onOpen(tab.id)}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm outline-none hover:bg-card/60 focus-visible:ring-2 focus-visible:ring-ring/70"
                >
                  <IntegrationIcon id={tab.id} className="size-4 shrink-0 opacity-80" />
                  <span className="min-w-0 flex-1 truncate font-medium text-ink">
                    {integrationLabel(tab.id)}
                  </span>
                  <StatusDot status={status} />
                  <span className="sr-only">, {statusText(status)}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
