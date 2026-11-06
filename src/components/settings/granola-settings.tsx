"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { ArrowUpRight, FolderOpen, History, MoreHorizontal, RefreshCw } from "lucide-react";
import {
  disconnectGranola,
  getGranolaFolders,
  getGranolaPanel,
  setGranolaFolders,
  startGranolaConnect,
  syncGranolaNow,
  type GranolaPanel,
} from "@/actions/granola";
import type { GranolaActivity, GranolaActivityPerson } from "@/lib/connectors/granola";
import type { GranolaFolder } from "@/lib/connectors/granola-xml";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { FeatureRow } from "@/components/settings/account-page";
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
  if (!panel) return <PageSkeleton />;

  const conn = panel.connection;
  if (!conn) {
    return (
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <GranolaMark className="size-10 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">Granola</p>
            <p className="text-sm text-muted-foreground">Your meeting notes, on the people you met</p>
          </div>
        </div>
        <div className="space-y-2 rounded-xl bg-muted/40 p-4 text-sm">
          <p className="font-medium text-ink">Each new note</p>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li>updates the people in it, or adds them</li>
            <li>logs the meeting at its real time</li>
            <li>refreshes their AI notes — nothing to review</li>
          </ul>
          <p className="text-muted-foreground">Works with every Granola plan. Brings in the last 30 days first.</p>
        </div>
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
      <div className="flex items-center gap-3">
        <GranolaMark className="size-10 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">Granola</p>
          <p className="truncate text-sm text-muted-foreground">{conn.accountRef ?? "Connected"}</p>
          <SyncStatus
            signedOut={signedOut}
            syncing={syncing}
            lastSyncedAt={conn.lastSyncedAt}
            error={conn.syncError}
          />
        </div>
        {signedOut ? null : (
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
        )}
        <AccountMenu
          onReconnect={connect}
          onDisconnect={() => run(disconnectGranola, "Couldn’t disconnect — try again?", "Granola disconnected")}
        />
      </div>

      {signedOut ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-warning/10 p-4 text-sm text-warning">
          <p className="min-w-0 flex-1">Granola signed Orbit out. Sign in again to keep syncing.</p>
          <Button size="sm" disabled={pending} onClick={connect}>
            Sign in again
          </Button>
        </div>
      ) : null}

      {/* `inert` while signed out: nothing below can do anything until the grant is back. */}
      <ul inert={signedOut} className={cn(signedOut && "opacity-60")}>
        {/* Keyed on the saved ids: a save remounts it from the new choice, while a reload
            that changed nothing (Sync now) leaves unsaved ticks alone. */}
        <FoldersRow
          key={panel.folderIds.join(",")}
          saved={panel.folderIds}
          disabled={pending || signedOut}
          onSave={(ids) => run(() => setGranolaFolders(ids), "Couldn’t save your folders — try again?", "Folders saved")}
        />
        <ActivityRow activity={panel.activity} />
      </ul>
    </div>
  );
}

function SyncStatus({
  signedOut,
  syncing,
  lastSyncedAt,
  error,
}: {
  signedOut: boolean;
  syncing: boolean;
  lastSyncedAt: Date | null;
  error: string | null;
}) {
  const [tone, text] = signedOut
    ? (["bg-warning", "Reconnect needed"] as const)
    : syncing
      ? (["bg-primary animate-pulse", "Syncing…"] as const)
      : error
        ? (["bg-warning", "Last sync hit a problem"] as const)
        : lastSyncedAt
          ? (["bg-primary", `Synced ${formatDistanceToNow(lastSyncedAt, { addSuffix: true })}`] as const)
          : (["bg-primary animate-pulse", "First sync is running"] as const);
  return (
    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground" title={error ?? undefined}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone)} />
      {text}
    </p>
  );
}

/** Reconnect and a confirmed Disconnect, behind the same ··· the account pages use. */
function AccountMenu({ onReconnect, onDisconnect }: { onReconnect: () => void; onDisconnect: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label="Granola account options" className="tap-target relative">
              <MoreHorizontal aria-hidden />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-auto min-w-40">
          <DropdownMenuItem onClick={onReconnect}>Reconnect</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}>
            Disconnect
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Disconnect Granola?</DialogTitle>
            <DialogDescription>
              Orbit stops bringing in new notes and deletes its copy of the sign-in. The contacts and meetings
              already logged from Granola stay in Orbit.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setConfirming(false);
                onDisconnect();
              }}
            >
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

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
      <li className="flex items-center gap-2 border-b border-border/60 pb-3 text-sm text-muted-foreground">
        <FolderOpen aria-hidden className="size-4 shrink-0" />
        {folders === undefined ? (
          <Skeleton className="h-4 w-48" />
        ) : folders === null ? (
          "Syncing every note · folder choice needs a paid Granola plan"
        ) : (
          "Syncing every note · no Granola folders yet"
        )}
      </li>
    );
  }

  const label = saved.length ? `${saved.length} folder${saved.length === 1 ? "" : "s"}` : "All notes";
  const next = onlyPicked ? picked : [];
  const dirty = next.length !== saved.length || next.some((id) => !saved.includes(id));
  const toggle = (id: string, on: boolean) => setPicked((p) => (on ? [...p, id] : p.filter((x) => x !== id)));

  return (
    <FeatureRow
      icon={<FolderOpen className="size-4" />}
      title="Folders"
      description="Bring in every note, or only the Granola folders you pick."
      control={{ kind: "action", label: open ? "Done" : label }}
      onAction={() => setOpen((o) => !o)}
      disabled={disabled}
    >
      {open ? (
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
                    {new Date(note.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
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

function PageSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading Granola">
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-xl" />
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-40" />
        </div>
      </div>
      <Skeleton className="h-24 w-full rounded-xl" />
    </div>
  );
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
