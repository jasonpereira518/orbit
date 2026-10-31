"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { FolderOpen, History, RefreshCw } from "lucide-react";
import {
  disconnectGranola,
  getGranolaFolders,
  getGranolaPanel,
  setGranolaFolders,
  startGranolaConnect,
  syncGranolaNow,
  type GranolaPanel,
} from "@/actions/granola";
import type { GranolaFolder } from "@/lib/connectors/granola-xml";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { FeatureRow } from "@/components/settings/account-page";
import { GranolaMark } from "@/components/settings/provider-marks";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const NO_CONTROL = { kind: "none" } as const;
const noop = () => {};

/**
 * Connect Granola, choose which notes it brings in, and see what it has done. No review queue
 * on purpose: new notes land on the people in them on the next sync.
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

  if (failed && !panel) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">Couldn’t check your Granola connection.</p>
        <Button variant="outline" size="sm" onClick={load}>
          Try again
        </Button>
      </div>
    );
  }
  if (!panel) return <Skeleton className="h-16 w-full rounded-2xl" />;

  const conn = panel.connection;
  if (!conn) {
    return (
      <section className="space-y-4">
        <Header title="Granola" subtitle="Your meeting notes, on the people you met" />
        <p className="text-sm text-muted-foreground">
          Each new Granola note updates the people in it: the meeting is logged at its real time and their AI notes
          are refreshed. Nothing to review. Works with every Granola plan; brings in the last 30 days, then each new
          note.
        </p>
        {result === "error" ? <p className="text-sm text-destructive">That didn’t connect. Try again.</p> : null}
        <Button disabled={pending} onClick={connect}>
          Connect Granola
        </Button>
      </section>
    );
  }

  const signedOut = conn.status === "needs_reauth";
  const syncing = conn.syncStatus === "syncing" || waiting;

  return (
    <div className="space-y-4">
      <Header
        title="Granola"
        subtitle={conn.accountRef ?? "Connected"}
        action={
          signedOut ? null : (
            <Button
              variant="outline"
              size="sm"
              disabled={pending || syncing}
              onClick={() => {
                setWaitingSince(Date.now());
                run(syncGranolaNow, "Couldn’t start a sync — try again?");
              }}
            >
              <RefreshCw aria-hidden className={cn(syncing && "animate-spin")} />
              {syncing ? "Syncing…" : "Sync now"}
            </Button>
          )
        }
      />

      {signedOut ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-warning/10 p-4 text-sm text-warning">
          <p className="min-w-0 flex-1">Granola signed Orbit out. Sign in again to keep syncing.</p>
          <Button size="sm" disabled={pending} onClick={connect}>
            Sign in again
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {syncing
            ? "Syncing now."
            : conn.lastSyncedAt
              ? `Last checked ${formatDistanceToNow(conn.lastSyncedAt, { addSuffix: true })}.`
              : "First sync is running."}
          {conn.syncError ? <span className="block text-destructive">{conn.syncError}</span> : null}
        </p>
      )}

      <ul inert={signedOut} className={cn("-my-1", signedOut && "opacity-60")}>
        <FeatureRow
          icon={<FolderOpen className="size-4" />}
          title="Folders"
          description="Bring in every note, or only the Granola folders you pick."
          control={NO_CONTROL}
          onAction={noop}
        >
          {/* Keyed on the saved ids: a save remounts it from the new choice, while a reload
              that changed nothing (Sync now) leaves unsaved ticks alone. */}
          <FolderPicker
            key={panel.folderIds.join(",")}
            saved={panel.folderIds}
            disabled={pending || signedOut}
            onSave={(ids) => run(() => setGranolaFolders(ids), "Couldn’t save your folders — try again?", "Folders saved")}
          />
        </FeatureRow>
        <FeatureRow
          icon={<History className="size-4" />}
          title="Recent activity"
          description={
            panel.activity.notes
              ? `${plural(panel.activity.notes, "note")} synced · ${plural(panel.activity.people, "person", "people")} updated`
              : "Nothing synced yet."
          }
          control={NO_CONTROL}
          onAction={noop}
        >
          {panel.activity.recent.length ? (
            <ul className="space-y-2.5">
              {panel.activity.recent.map((note) => (
                <li key={note.noteId} className="text-sm">
                  <p className="font-medium text-ink">{note.title}</p>
                  <p className="text-muted-foreground">
                    {new Date(note.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                    {" · "}
                    {note.people.map((p, i) => (
                      <span key={p.id}>
                        {i ? ", " : ""}
                        <Link href={`/contacts/${p.id}`} className="underline underline-offset-2 hover:text-foreground">
                          {p.name}
                        </Link>
                      </span>
                    ))}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
        </FeatureRow>
      </ul>

      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => run(disconnectGranola, "Couldn’t disconnect — try again?")}
      >
        Disconnect Granola
      </Button>
    </div>
  );
}

function Header({ title, subtitle, action }: { title: string; subtitle: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <GranolaMark className="size-10 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{title}</p>
        <p className="truncate text-sm text-muted-foreground">{subtitle}</p>
      </div>
      {action}
    </div>
  );
}

/**
 * "All notes" or a chosen set. Saving restarts the 30-day look-back so a newly picked folder's
 * older notes come in; notes already logged are never logged twice.
 */
function FolderPicker({
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
  const [picked, setPicked] = useState<string[]>(saved);
  const [onlyPicked, setOnlyPicked] = useState(saved.length > 0);

  useEffect(() => {
    getGranolaFolders().then(setFolders, () => setFolders(null));
  }, []);

  if (folders === undefined) return <Skeleton className="h-5 w-48" />;
  if (folders === null) {
    return <p className="text-sm text-muted-foreground">Syncing every note. Folder choice needs a paid Granola plan.</p>;
  }
  if (!folders.length) {
    return <p className="text-sm text-muted-foreground">Syncing every note. You have no folders in Granola yet.</p>;
  }

  const next = onlyPicked ? picked : [];
  const dirty = next.length !== saved.length || next.some((id) => !saved.includes(id));
  const toggle = (id: string, on: boolean) => setPicked((p) => (on ? [...p, id] : p.filter((x) => x !== id)));

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Which notes to sync" className="flex flex-wrap gap-4 text-sm">
        {[
          { value: false, label: "All notes" },
          { value: true, label: "Only these folders" },
        ].map((o) => (
          <label key={o.label} className="flex items-center gap-2">
            <input
              type="radio"
              name="granola-folders"
              checked={onlyPicked === o.value}
              disabled={disabled}
              onChange={() => setOnlyPicked(o.value)}
              className="accent-primary"
            />
            {o.label}
          </label>
        ))}
      </div>
      {onlyPicked ? (
        <ul className="space-y-2">
          {folders.map((f) => (
            <li key={f.id}>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={picked.includes(f.id)} disabled={disabled} onCheckedChange={(on) => toggle(f.id, on)} />
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
  );
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
