"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowUpRight, FolderOpen, History, RefreshCw, Sparkles } from "lucide-react";
import {
  disconnectGranola,
  getGranolaFolders,
  getGranolaPanel,
  setGranolaAutoExtract,
  setGranolaFolders,
  startGranolaConnect,
  syncGranolaNow,
  type GranolaPanel,
} from "@/actions/granola";
import type { GranolaActivity, GranolaActivityPerson } from "@/lib/connectors/granola";
import type { GranolaFolder } from "@/lib/connectors/granola-xml";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { AccountPageShell, FeatureRow, syncStatusLine, whenLine } from "@/components/settings/account-page";
import { SegmentedControl } from "@/components/settings/account-rows";
import { PROVIDER_THEMES } from "@/components/settings/provider-themes";
import type { AccountStatus } from "@/lib/integration-status";
import { GranolaMark } from "@/components/settings/provider-marks";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const NO_CONTROL = { kind: "none" } as const;
const noop = () => {};
/** Notes shown before "Show all". */
const FIRST_NOTES = 5;
/** Faces in a note's avatar stack before "+N". */
const STACK_FACES = 4;

/**
 * Connect Granola, choose which notes it brings in, and see what it has done — drawn in the
 * same frame as the Google and Microsoft pages (`account-page.tsx`): the account stated once
 * at the top with its menu, then a row per feature. No review queue on purpose: new notes land
 * on the people in them on the next sync.
 */
export function GranolaSettings() {
  const [panel, setPanel] = useState<GranolaPanel | null>(null);
  const [failed, setFailed] = useState(false);
  const [pending, start] = useTransition();
  const result = useSearchParams().get("granola");

  const load = useCallback(() => {
    getGranolaPanel().then(
      (p) => {
        setPanel(p);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, []);
  useEffect(load, [load]);

  // After Sync now: the pass starts a moment later, so re-read until it has finished (the
  // last-checked time moves past the click) or a minute has gone by.
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

  const run = (fn: () => Promise<unknown>, fallback: string, done?: string) =>
    start(async () => {
      try {
        await fn();
        if (done) toast.success(done);
        load();
      } catch (err) {
        toast.error(friendlyError(err, fallback));
      }
    });

  const connect = () =>
    start(async () => {
      try {
        const { url } = await startGranolaConnect();
        window.location.assign(url);
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t reach Granola — try again?"));
      }
    });

  const conn = panel?.connection ?? null;
  const account: AccountStatus | null = panel
    ? {
        state: !conn ? "not_connected" : conn.status === "needs_reauth" ? "needs_reauth" : "connected",
        email: conn?.accountRef ?? null,
        capabilities: {},
      }
    : null;
  const signedOut = conn?.status === "needs_reauth";
  const syncing = conn?.syncStatus === "syncing" || waiting;

  return (
    <AccountPageShell
      name="Granola"
      mark={<GranolaMark className="size-6" />}
      theme={theme}
      account={account}
      loading={!panel && !failed}
      failed={failed}
      onRetry={load}
      onConnect={connect}
      connectCopy={GRANOLA_CONNECT}
      connectError={result === "error" ? "That didn’t connect. Try again." : null}
      connectBusy={pending}
      signedOutText="Granola signed Orbit out. Sign in again to keep syncing."
      status={syncStatusLine({ signedOut, syncing, lastSyncedAt: conn?.lastSyncedAt, error: conn?.syncError })}
      primaryAction={{
        label: syncing ? "Syncing…" : "Sync now",
        icon: <RefreshCw aria-hidden className={cn(syncing && "animate-spin")} />,
        disabled: pending || syncing,
        onClick: () => {
          setWaitingSince(Date.now());
          run(syncGranolaNow, "Couldn’t start a sync — try again?");
        },
      }}
      menuItems={[{ label: "Reconnect", onSelect: connect }]}
      disconnect={{
        provider: "granola",
        hasDeletableData: false,
        onConfirm: () => run(disconnectGranola, "Couldn’t disconnect — try again?", "Granola disconnected"),
      }}
    >
      {panel && conn ? (
        <>
          <FeatureRow
            icon={<Sparkles className="size-4" />}
            tone={theme.tone}
            title="Automatic extraction"
            description={
              panel.autoExtract
                ? "New notes update the people in them on their own."
                : "Off: pick notes yourself from Capture → Notes library → From Granola."
            }
            control={{ kind: "switch", on: panel.autoExtract }}
            disabled={pending || signedOut}
            onAction={() =>
              run(
                () => setGranolaAutoExtract(!panel.autoExtract),
                "Couldn’t change that — try again?",
                panel.autoExtract ? "Granola notes now come in only when you pick them" : "New Granola notes will be extracted automatically",
              )
            }
          />
          {/* Keyed on the saved ids: a save remounts it from the new choice, while a reload
              that changed nothing (Sync now) leaves unsaved ticks alone. */}
          <FoldersRow
            key={panel.folderIds.join(",")}
            saved={panel.folderIds}
            disabled={pending || signedOut}
            onSave={(ids) => run(() => setGranolaFolders(ids), "Couldn’t save your folders — try again?", "Folders saved")}
          />
          <ActivityRow activity={panel.activity} />
        </>
      ) : null}
    </AccountPageShell>
  );
}

const theme = PROVIDER_THEMES.granola;

const GRANOLA_CONNECT = {
  intro: "Your meeting notes, on the people you met.",
  asksTitle: "Each new note",
  asks: ["Updates the people in it, or adds them", "Logs the meeting at its real time", "Refreshes their AI notes — nothing to review"],
  note: "Works with every Granola plan. Brings in the last 30 days first.",
} as const;

/**
 * "All notes" or a chosen set. With no folders to choose from — none in Granola yet, or a Free
 * plan without folder tools — it is one quiet line, not a section about a setting nobody can
 * set. Saving restarts the 30-day look-back so a newly picked folder's older notes come in.
 */
function FoldersRow({
  saved,
  disabled,
  onSave,
}: {
  saved: string[];
  disabled: boolean;
  onSave: (ids: string[]) => void;
}) {
  // undefined: loading. null: Granola won't list folders (Free plan, or unreachable).
  const [folders, setFolders] = useState<GranolaFolder[] | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>(saved);
  const [onlyPicked, setOnlyPicked] = useState(saved.length > 0);

  useEffect(() => {
    getGranolaFolders().then(setFolders, () => setFolders(null));
  }, []);

  if (!folders?.length) {
    return (
      <FeatureRow
        icon={<FolderOpen className="size-4" />}
        tone={theme.tone}
        title="Folders"
        description={
          folders === undefined ? (
            "Checking your Granola folders…"
          ) : folders === null ? (
            "Syncing every note. Picking folders needs a paid Granola plan."
          ) : (
            "Syncing every note. No Granola folders yet."
          )
        }
        control={NO_CONTROL}
        onAction={noop}
      />
    );
  }

  const label = saved.length ? `${saved.length} folder${saved.length === 1 ? "" : "s"}` : "All notes";
  const next = onlyPicked ? picked : [];
  const dirty = next.length !== saved.length || next.some((id) => !saved.includes(id));
  const toggle = (id: string, on: boolean) => setPicked((p) => (on ? [...p, id] : p.filter((x) => x !== id)));

  return (
    <FeatureRow
      icon={<FolderOpen className="size-4" />}
      tone={theme.tone}
      title="Folders"
      description="Bring in every note, or only the Granola folders you pick."
      control={{ kind: "action", label: open ? "Done" : label }}
      onAction={() => setOpen((o) => !o)}
      disabled={disabled}
    >
      {open ? (
        <div className="space-y-3">
          <SegmentedControl
            label="Which notes to sync"
            options={[
              { value: false, label: "All notes" },
              { value: true, label: "Only these folders" },
            ]}
            value={onlyPicked}
            onChange={setOnlyPicked}
            disabled={disabled}
          />
          {onlyPicked ? (
            <ul className="space-y-2">
              {folders.map((f) => (
                <li key={f.id}>
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={picked.includes(f.id)}
                      disabled={disabled}
                      onCheckedChange={(on) => toggle(f.id, on)}
                    />
                    <span className="min-w-0 truncate">{f.title}</span>
                    {f.noteCount != null ? <span className="text-muted-foreground">{f.noteCount}</span> : null}
                  </label>
                </li>
              ))}
            </ul>
          ) : null}
          {dirty ? (
            <Button size="sm" disabled={disabled || (onlyPicked && !picked.length)} onClick={() => onSave(next)}>
              Save folders
            </Button>
          ) : null}
        </div>
      ) : null}
    </FeatureRow>
  );
}

function ActivityRow({ activity }: { activity: GranolaActivity }) {
  const [showAll, setShowAll] = useState(false);
  const notes = showAll ? activity.recent : activity.recent.slice(0, FIRST_NOTES);
  const hidden = activity.recent.length - notes.length;

  return (
    <FeatureRow
      icon={<History className="size-4" />}
      tone={theme.tone}
      title="Recent activity"
      description={
        activity.notes
          ? `${plural(activity.notes, "note")} · ${plural(activity.people, "person", "people")}`
          : "Nothing synced yet. New notes show up here after the next sync."
      }
      control={NO_CONTROL}
      onAction={noop}
    >
      {notes.length ? (
        <>
          <ul className="divide-y divide-border/60">
            {notes.map((note) => (
              <li key={note.noteId} className="py-2.5 first:pt-0">
                <div className="flex items-baseline gap-2">
                  <p className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{note.title}</p>
                  <time dateTime={new Date(note.at).toISOString()} className="shrink-0 text-xs text-muted-foreground">
                    {whenLine(note.at)}
                  </time>
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <AvatarStack people={note.people} />
                  <a
                    href={note.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    Open in Granola
                    <ArrowUpRight aria-hidden className="size-3" />
                  </a>
                </div>
              </li>
            ))}
          </ul>
          {hidden > 0 || showAll ? (
            <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setShowAll((s) => !s)}>
              {showAll ? "Show fewer" : `Show all ${activity.recent.length}`}
            </Button>
          ) : null}
        </>
      ) : null}
    </FeatureRow>
  );
}

/** Up to four faces, each linking to the person, then "+N" naming the rest on hover. */
function AvatarStack({ people }: { people: GranolaActivityPerson[] }) {
  const faces = people.slice(0, STACK_FACES);
  const rest = people.slice(STACK_FACES);
  return (
    <div className="flex min-w-0 items-center">
      <div className="flex -space-x-1.5">
        {faces.map((p) => (
          <Link key={p.id} href={`/contacts/${p.id}`} title={p.name} className="rounded-full ring-2 ring-background">
            <ContactAvatar
              contactId={p.id}
              fullName={p.name}
              firstName={p.firstName}
              profileImageUrl={p.photo}
              size="sm"
            />
          </Link>
        ))}
      </div>
      {rest.length ? (
        <span
          title={rest.map((p) => p.name).join(", ")}
          className="ml-1.5 text-xs text-muted-foreground"
        >
          +{rest.length}
        </span>
      ) : null}
      {people.length === 1 ? (
        <Link href={`/contacts/${people[0].id}`} className="ml-2 truncate text-xs text-muted-foreground hover:text-foreground">
          {people[0].name}
        </Link>
      ) : null}
    </div>
  );
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
