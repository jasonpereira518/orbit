"use client";

import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IntegrationIcon, StatusDot, statusText } from "@/components/settings/integration-ui";
import { OVERVIEW_TABS, integrationLabel, type IntegrationTabId } from "@/components/settings/sections";
import { overviewAction, type IntegrationStatuses } from "@/lib/integration-status";

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
 * its status and the one thing to do next. Advanced pages get no card — they are reachable
 * from the nav for the people who want them.
 */
export function IntegrationsOverview({
  tabs,
  statuses,
  onOpen,
}: {
  /** Visible pages — hidden surfaces already filtered out. */
  tabs: IntegrationTabId[];
  statuses: IntegrationStatuses | null;
  onOpen: (tab: IntegrationTabId) => void;
}) {
  const cards = OVERVIEW_TABS.filter((id) => tabs.includes(id));
  const attention = (statuses?.attention ?? []).filter((item) => tabs.includes(item.tab));

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-medium text-ink">Overview</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          What Orbit is connected to, and what’s left to set up.
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
                <h4 className="text-sm font-medium text-ink">{integrationLabel(id)}</h4>
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
                  onClick={() => onOpen(id)}
                >
                  {action.label}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
