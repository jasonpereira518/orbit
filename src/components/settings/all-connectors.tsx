"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, Search } from "lucide-react";
import { submitFeedback } from "@/actions/feedback";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CATALOG, matchesCatalogQuery, type CatalogItem } from "@/components/settings/integration-catalog";
import { StatusDot, statusText } from "@/components/settings/integration-ui";
import type { IntegrationTabId } from "@/components/settings/sections";
import {
  overviewAction,
  type AccountProvider,
  type IntegrationStatuses,
} from "@/lib/integration-status";
import type { ConnectorStatusId } from "@/lib/connectors/status";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * The "All connectors" page: everything Orbit connects to as one catalog of logo tiles,
 * grouped the way a person looks for them (`CATALOG`). The Overview shows only what is on;
 * this is where someone goes to find what else there is.
 *
 * Partner marks keep their brand colours; everything around them is Orbit's palette, with
 * each group's dot in one of the theme's accent tokens.
 *
 * "Connect Google" / "Connect Microsoft" (`overviewAction`'s `connects`) starts the consent
 * screen from the tile, because opening the page only to press Connect again is a step that
 * says nothing. Tile buttons that open a page carry `data-integration-card`.
 *
 * A planned integration's Request goes through the feedback widget's own action, so requests
 * land in /admin/feedback beside everything else people ask for — no table of its own.
 */
export function AllConnectors({
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
  const [query, setQuery] = useState("");
  const [requested, setRequested] = useState<string[]>([]);

  // A tab tile whose page is hidden for this viewer is hidden with it.
  const groups = CATALOG.map((group) => ({
    ...group,
    items: group.items.filter(
      (entry) => (!("tab" in entry.to) || tabs.includes(entry.to.tab)) && matchesCatalogQuery(entry, query)
    ),
  })).filter((group) => group.items.length > 0);

  async function request(entry: Pick<CatalogItem, "id" | "label">) {
    setRequested((ids) => [...ids, entry.id]);
    try {
      const result = await submitFeedback({
        text: `Integration request: ${entry.label} (${entry.id})`,
        area: "import",
        category: "idea",
        path: window.location.pathname,
      });
      if (!result.ok) throw new Error(result.message);
      toast.success(`Asked for ${entry.label} — thanks`);
    } catch (err) {
      setRequested((ids) => ids.filter((id) => id !== entry.id));
      toast.error(friendlyError(err, "Couldn’t send that request — try again in a moment"));
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-lg font-medium text-ink">All connectors</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything Orbit connects to, and what’s coming next.
        </p>
      </div>


      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search integrations"
          aria-label="Search integrations"
          className="pl-9"
        />
      </div>

      {groups.map((group) => (
        <section key={group.key} aria-labelledby={`integration-group-${group.key}`} className="space-y-2.5">
          <h4
            id={`integration-group-${group.key}`}
            className="flex items-center gap-2 text-[0.6875rem] font-semibold tracking-[0.08em] text-muted-foreground-subtle uppercase"
          >
            <span aria-hidden className={cn("size-1.5 rounded-full", group.accent)} />
            {group.label}
          </h4>
          <ul className="grid gap-2.5 sm:grid-cols-2">
            {group.items.map((entry) => (
              <CatalogTile
                key={entry.id}
                entry={entry}
                statuses={statuses}
                runningTab={runningTab}
                connecting={connecting}
                requested={requested.includes(entry.id)}
                onOpen={onOpen}
                onConnect={onConnect}
                onRequest={() => void request(entry)}
              />
            ))}
          </ul>
        </section>
      ))}

      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing matches “{query.trim()}”.{" "}
          <button
            type="button"
            className="text-primary underline-offset-2 hover:underline"
            onClick={() => void request({ id: `search:${query.trim()}`, label: query.trim() })}
          >
            Ask for it
          </button>
        </p>
      ) : null}

    </div>
  );
}

function CatalogTile({
  entry,
  statuses,
  runningTab,
  connecting,
  requested,
  onOpen,
  onConnect,
  onRequest,
}: {
  entry: CatalogItem;
  statuses: IntegrationStatuses | null;
  runningTab: IntegrationTabId | null;
  connecting: AccountProvider | null;
  requested: boolean;
  onOpen: (tab: IntegrationTabId) => void;
  onConnect: (provider: AccountProvider) => void;
  onRequest: () => void;
}) {
  const { to } = entry;
  const nameId = `integration-card-name-${entry.id}`;
  const planned = "planned" in to;
  const tab = "tab" in to ? to.tab : null;
  // A dialog page reports per page; anything set up elsewhere reports per connector.
  const status = planned ? undefined : tab ? statuses?.pages[tab] : statuses?.connectors[entry.id as ConnectorStatusId];
  const showStatus = !planned && !(status && status !== "unknown" && status.state === "none");
  const Mark = entry.mark;

  let control: React.ReactNode;
  if (tab) {
    const account = tab === "google" || tab === "microsoft" ? statuses?.accounts[tab] : undefined;
    const action = overviewAction(tab, status, account);
    control = (
      <Button
        size="sm"
        variant={action.primary ? "default" : "outline"}
        data-integration-card={tab}
        // Sighted readers get the tile around it; a screen reader announcing the buttons on
        // their own would otherwise hear "Manage" over and over.
        aria-describedby={nameId}
        disabled={action.connects ? connecting === action.connects : undefined}
        onClick={() => (action.connects ? onConnect(action.connects) : onOpen(tab))}
      >
        {action.label}
      </Button>
    );
  } else if ("href" in to) {
    control = (
      <Link href={to.href} aria-describedby={nameId} className={buttonVariants({ size: "sm", variant: "outline" })}>
        Open
      </Link>
    );
  } else {
    control = (
      <Button size="sm" variant="ghost" aria-describedby={nameId} disabled={requested} onClick={onRequest}>
        {requested ? (
          <>
            <Check aria-hidden className="size-3.5" /> Requested
          </>
        ) : (
          "Request"
        )}
      </Button>
    );
  }

  return (
    <li
      className={cn(
        "flex items-start gap-3 rounded-xl border border-border/60 bg-card p-3",
        planned && "border-dashed bg-transparent"
      )}
    >
      <span
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-lg bg-background ring-1 ring-border/60",
          planned && "opacity-70 grayscale-[35%]"
        )}
      >
        <Mark className="size-5 text-ink" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p id={nameId} className="flex flex-wrap items-center gap-x-1.5 text-sm font-medium text-ink">
          {entry.label}
          {planned ? <Badge variant="secondary">Coming soon</Badge> : null}
          {tab && runningTab === tab ? <span className="font-normal text-muted-foreground">· running</span> : null}
        </p>
        <p className="text-xs text-muted-foreground">{entry.blurb}</p>
        {showStatus ? (
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <StatusDot status={status} />
            <span className="truncate">{statusText(status)}</span>
          </p>
        ) : null}
        <div className="pt-1.5">{control}</div>
      </div>
    </li>
  );
}
