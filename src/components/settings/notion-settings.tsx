"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { FileText, KeyRound, Loader2, RefreshCw, Users } from "lucide-react";
import {
  disconnectNotion,
  getNotionColumns,
  getNotionDatabases,
  getNotionPanel,
  setNotionDatabase,
  startNotionConnect,
  syncNotionNow,
  type NotionPanel,
} from "@/actions/notion";
import type { NotionColumn, NotionDataSource, NotionMapping } from "@/lib/connectors/notion";
import type { NotionPersonField } from "@/db/schema";
import { AccountPageShell, FeatureRow, syncStatusLine } from "@/components/settings/account-page";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { PROVIDER_THEMES } from "@/components/settings/provider-themes";
import { NotionMark } from "@/components/settings/provider-marks";
import type { AccountStatus } from "@/lib/integration-status";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";

const theme = PROVIDER_THEMES.notion;
const NO_CONTROL = { kind: "none" } as const;
const noop = () => {};

const NOTION_CONNECT = {
  intro: "Your Notion notes and people, in Orbit.",
  asksTitle: "Notion will ask you",
  asks: ["Which pages and databases Orbit may read", "Nothing else: Orbit never edits Notion"],
  note: "Works with every Notion plan. You can change the pages later by reconnecting.",
} as const;

/**
 * Connect Notion and choose what Orbit may read — in the same frame as the other account pages
 * (`account-page.tsx`). Notion's own consent screen is where pages are picked, so "Choose pages"
 * is a reconnect.
 */
export function NotionSettings() {
  const [panel, setPanel] = useState<NotionPanel | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, start] = useTransition();
  const result = useSearchParams().get("notion");

  const load = useCallback(() => {
    getNotionPanel().then(
      (p) => {
        setPanel(p);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, []);
  useEffect(load, [load]);

  const connect = () =>
    start(async () => {
      try {
        const { url } = await startNotionConnect();
        window.location.assign(url);
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t reach Notion — try again?"));
      }
    });

  // After Sync now or a new database: re-read until the pass has finished, or a minute passes.
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const lastSynced = panel?.connection?.lastSyncedAt ? new Date(panel.connection.lastSyncedAt).getTime() : 0;
  const waiting = waitingSince !== null && lastSynced < waitingSince;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      if (Date.now() - waitingSince > 60_000) setWaitingSince(null);
      else load();
    }, 2000);
    return () => clearInterval(timer);
  }, [waiting, waitingSince, load]);

  const conn = panel?.connection ?? null;
  const signedOut = conn?.status === "needs_reauth";
  const database = panel?.workspace?.dataSourceId ? panel.workspace : null;
  const syncing = conn?.syncStatus === "syncing" || waiting;
  const account: AccountStatus | null = panel
    ? {
        state: !conn ? "not_connected" : signedOut ? "needs_reauth" : "connected",
        email: panel.workspace?.workspaceName ?? conn?.accountRef ?? null,
        capabilities: {},
      }
    : null;

  return (
    <AccountPageShell
      name="Notion"
      mark={<NotionMark className="size-6" />}
      theme={theme}
      account={account}
      loading={!panel && !failed}
      failed={failed}
      onRetry={load}
      onConnect={connect}
      connectCopy={NOTION_CONNECT}
      connectError={result === "error" ? "That didn’t connect. Try again." : null}
      connectBusy={pending}
      signedOutText="Notion signed Orbit out. Reconnect to keep reading your pages."
      status={database ? syncStatusLine({ signedOut, syncing, lastSyncedAt: conn?.lastSyncedAt, error: conn?.syncError }) : undefined}
      primaryAction={
        database
          ? {
              label: syncing ? "Syncing…" : "Sync now",
              icon: <RefreshCw aria-hidden className={cn(syncing && "animate-spin")} />,
              disabled: pending || syncing,
              onClick: () =>
                start(async () => {
                  setWaitingSince(Date.now());
                  try {
                    await syncNotionNow();
                  } catch (err) {
                    toast.error(friendlyError(err, "Couldn’t start a sync — try again?"));
                  }
                }),
            }
          : undefined
      }
      menuItems={[{ label: "Reconnect", onSelect: connect }]}
      disconnect={{
        provider: "notion",
        hasDeletableData: false,
        onConfirm: () =>
          start(async () => {
            try {
              await disconnectNotion();
              toast.success("Notion disconnected");
              load();
            } catch (err) {
              toast.error(friendlyError(err, "Couldn’t disconnect — try again?"));
            }
          }),
      }}
    >
      {panel && conn ? (
        <>
          <FeatureRow
            icon={<KeyRound className="size-4" />}
            tone={theme.tone}
            title="Pages Orbit can read"
            description="Only the pages and databases you shared with Orbit in Notion."
            control={{ kind: "action", label: "Choose pages" }}
            disabled={pending}
            onAction={connect}
          />
          <FeatureRow
            icon={<FileText className="size-4" />}
            tone={theme.tone}
            title="Notes from pages"
            description="Pick pages from Capture → Notes library → From Notion. You review the people before anything saves."
            control={NO_CONTROL}
            onAction={noop}
          />
          <PeopleDatabaseRow
            chosen={database ? { id: database.dataSourceId!, title: database.dataSourceTitle ?? "your database" } : null}
            disabled={pending || signedOut}
            onSaved={() => {
              setWaitingSince(Date.now());
              load();
            }}
          />
        </>
      ) : null}
    </AccountPageShell>
  );
}

const FIELD_LABELS: [NotionPersonField, string][] = [
  ["fullName", "Name"],
  ["email", "Email"],
  ["phone", "Phone"],
  ["linkedinUrl", "LinkedIn"],
  ["company", "Company"],
  ["title", "Job title"],
  ["location", "Location"],
  ["notes", "Notes"],
];
const UNUSED = "__none__";

/**
 * "Sync a people database": pick one of the databases shared with Orbit, check which column
 * fills which contact field (pre-guessed), and save. Rows come in on every sync; a row only
 * fills blanks on a contact already in Orbit.
 */
function PeopleDatabaseRow({
  chosen,
  disabled,
  onSaved,
}: {
  chosen: { id: string; title: string } | null;
  disabled: boolean;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [databases, setDatabases] = useState<NotionDataSource[] | null>(null);
  const [picked, setPicked] = useState<string | null>(chosen?.id ?? null);
  const [columns, setColumns] = useState<NotionColumn[] | null>(null);
  const [mapping, setMapping] = useState<NotionMapping>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();

  useEffect(() => {
    if (!open) return;
    getNotionDatabases().then(
      (res) => (res.ok ? setDatabases(res.value) : setError(res.error)),
      () => setError("Couldn’t load your Notion databases — try again?"),
    );
  }, [open]);

  useEffect(() => {
    if (!open || !picked) return;
    getNotionColumns(picked).then(
      (res) => {
        if (!res.ok) return setError(res.error);
        setColumns(res.value.columns);
        setMapping(res.value.guess);
      },
      () => setError("Couldn’t read that database — try again?"),
    );
  }, [open, picked]);

  const save = (stop = false) =>
    startSave(async () => {
      const title = databases?.find((d) => d.id === picked)?.title ?? "";
      const res = await setNotionDatabase(stop || !picked ? null : { dataSourceId: picked, title, mapping }).catch(() => null);
      if (!res || !res.ok) {
        toast.error(res && !res.ok ? res.error : "Couldn’t save that — try again?");
        return;
      }
      toast.success(stop ? "Stopped syncing your Notion database" : `Syncing “${title}” into contacts`);
      setOpen(false);
      onSaved();
    });

  const options = (field: NotionPersonField) =>
    (columns ?? []).filter((c) => (field === "fullName" ? c.type === "title" : c.type !== "title"));

  return (
    <FeatureRow
      icon={<Users className="size-4" />}
      tone={theme.tone}
      title="People database"
      description={
        chosen
          ? `Syncing “${chosen.title}” into contacts. New and edited rows come in on each sync.`
          : "Turn a Notion table of people into Orbit contacts. Blanks get filled; nothing you typed in Orbit is overwritten."
      }
      control={{ kind: "action", label: open ? "Close" : chosen ? "Change" : "Choose" }}
      onAction={() => setOpen((o) => !o)}
      disabled={disabled}
    >
      {open ? (
        <div className="space-y-3">
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {databases === null && !error ? (
            <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Looking for databases shared with Orbit…
            </p>
          ) : databases?.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No databases are shared with Orbit. Use “Choose pages” above to share one.
            </p>
          ) : databases ? (
            <>
              <Select value={picked ?? ""} onValueChange={(v) => {
                  setColumns(null);
                  setPicked(v || null);
                }} items={databases.map((d) => ({ value: d.id, label: d.title }))}>
                <SelectTrigger aria-label="Notion database" className="h-9 w-full sm:w-72">
                  <SelectValue placeholder="Pick a database" />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false} className="p-1">
                  {databases.map((d) => (
                    <SelectItem key={d.id} value={d.id} className="py-1.5 pl-2">
                      {d.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {picked && columns === null && !error ? (
                <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Reading its columns…
                </p>
              ) : null}
              {columns ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {FIELD_LABELS.map(([field, label]) => {
                    const choices = options(field);
                    const items = [
                      ...(field === "fullName" ? [] : [{ value: UNUSED, label: "Not used" }]),
                      ...choices.map((c) => ({ value: c.id, label: c.name })),
                    ];
                    return (
                      <label key={field} className="flex items-center justify-between gap-2 text-sm">
                        <span className="text-muted-foreground">{label}</span>
                        <Select
                          value={mapping[field] ?? UNUSED}
                          onValueChange={(v) =>
                            setMapping((m) => {
                              const next = { ...m };
                              if (!v || v === UNUSED) delete next[field];
                              else next[field] = v;
                              return next;
                            })
                          }
                          items={items}
                        >
                          <SelectTrigger aria-label={`Column for ${label}`} className="h-8 w-40">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent alignItemWithTrigger={false} className="p-1">
                            {items.map((item) => (
                              <SelectItem key={item.value} value={item.value} className="py-1.5 pl-2">
                                {item.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </label>
                    );
                  })}
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button type="button" size="sm" disabled={saving || !columns || !mapping.fullName} onClick={() => save()}>
                  {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                  {chosen ? "Save" : "Start syncing"}
                </Button>
                {chosen ? (
                  <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => save(true)}>
                    Stop syncing
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </FeatureRow>
  );
}
