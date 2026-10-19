"use client";

import { useState } from "react";
import { ChevronRight, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IntegrationIcon, StatusDot, statusText } from "@/components/settings/integration-ui";
import { TONE } from "@/lib/tone";
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
  linkedin: "Your connections and messages.",
  ai: "Turns your notes into contacts and answers questions about your network.",
  assistants: "Use Orbit from inside Claude or ChatGPT.",
  reminders: "See your follow-ups next to your meetings.",
};

/**
 * The Integrations dialog's home: anything that needs fixing, then one card per account with
 * its status and the one thing to do next. Advanced pages get no card — on wide screens they
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
  const cards = OVERVIEW_TABS.filter((id) => tabs.includes(id));
  const attention = (statuses?.attention ?? []).filter((item) => tabs.includes(item.tab));
  const advancedTabs = INTEGRATION_TABS.filter((t) => t.group === "advanced" && tabs.includes(t.id));
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-heading text-lg font-medium text-ink">Overview</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          What Orbit is connected to, and what’s left to set up.
        </p>
      </div>

      {attention.length > 0 ? (
        <ul aria-label="Needs your attention" className="space-y-2">
          {attention.map((item) => (
            <li
              key={item.id}
              className={cn("flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2.5 text-sm", TONE.warning.box)}
            >
              <TriangleAlert aria-hidden className={cn("size-4 shrink-0", TONE.warning.text)} />
              <span className="min-w-0 flex-1 text-foreground">{item.message}</span>
              <Button size="sm" variant="outline" onClick={() => onOpen(item.tab)}>
                {item.action}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      <ul className="grid gap-3 sm:grid-cols-2">
        {cards.map((id) => {
          const status = statuses?.pages[id];
          const account = id === "google" || id === "microsoft" ? statuses?.accounts[id] : undefined;
          const action = overviewAction(id, status, account);
          const showStatus = !(status && status !== "unknown" && status.state === "none");
          return (
            <li key={id} className="flex flex-col gap-3 rounded-xl border border-border-subtle bg-card p-4">
              <div className="flex items-center gap-2.5">
                <IntegrationIcon id={id} size="md" />
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

      {advancedTabs.length > 0 ? (
        <div className="border-t border-border-subtle pt-4 md:hidden">
          <Button
            type="button"
            variant="ghost"
            aria-expanded={advancedOpen}
            aria-controls="integration-overview-advanced"
            onClick={() => setAdvancedOpen((wasOpen) => !wasOpen)}
            className="w-full justify-start text-muted-foreground"
          >
            <ChevronRight
              aria-hidden
              className={cn(
                "size-4 shrink-0 transition-transform duration-fast ease-house",
                advancedOpen && "rotate-90"
              )}
            />
            Advanced
          </Button>
          <div id="integration-overview-advanced" hidden={!advancedOpen} className="space-y-1 pt-1">
            <p className="px-2.5 pb-2 text-xs text-muted-foreground">
              For developers and automation tools. You don’t need anything here to use Orbit.
            </p>
            {advancedTabs.map((tab) => {
              const status = statuses?.pages[tab.id];
              return (
                <Button
                  key={tab.id}
                  type="button"
                  variant="ghost"
                  data-integration-card={tab.id}
                  onClick={() => onOpen(tab.id)}
                  className="h-auto w-full justify-start gap-2.5 px-2.5 py-2"
                >
                  <IntegrationIcon id={tab.id} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-left font-medium text-ink">
                    {integrationLabel(tab.id)}
                  </span>
                  <StatusDot status={status} />
                  <span className="sr-only">, {statusText(status)}</span>
                </Button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
