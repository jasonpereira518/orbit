"use client";

import { formatDistanceToNow } from "date-fns";
import { FileText, Loader2, RefreshCw, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  checkCloudNotesNow,
  dismissCloudNotes,
  extractCloudNotes,
  listCloudNoteFiles,
  saveCloudNotesAutoExtract,
  type CloudNotesState,
  type FoundCloudNote,
  type PickerFile,
} from "@/actions/cloud-notes";
import { startGmailOAuth } from "@/actions/gmail";
import { startOutlookOAuth } from "@/actions/outlook";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { CloudProvider } from "@/lib/cloud-files";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const DRIVE_LABEL: Record<CloudProvider, string> = { google: "Google Drive", microsoft: "OneDrive" };
const MAX_PICK = 25;

type Pickable = { provider: CloudProvider; id: string; name: string; webUrl: string | null; modifiedTime: string | null };

function fromFound(f: FoundCloudNote): Pickable {
  return { provider: f.provider, id: f.fileId, name: f.name, webUrl: f.webUrl, modifiedTime: f.modifiedAt };
}

function newBatchId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Extract docs from one or both drives as one batch: one call per drive, same batch id, so the
 * queue panel shows them together. Returns how many were queued.
 */
async function extractPicked(picked: Pickable[]): Promise<number> {
  const batchGroupId = newBatchId();
  let queued = 0;
  let duplicates = 0;
  const failures: string[] = [];
  for (const provider of ["google", "microsoft"] as const) {
    const files = picked.filter((p) => p.provider === provider);
    if (!files.length) continue;
    const res = await extractCloudNotes({
      provider,
      batchGroupId,
      files: files.map((f) => ({ id: f.id, name: f.name, webUrl: f.webUrl, modifiedTime: f.modifiedTime })),
    });
    if (!res.ok) {
      failures.push(res.error);
      continue;
    }
    queued += res.value.queued.length;
    duplicates += res.value.duplicates.length;
    failures.push(...res.value.failed.map((f) => `${f.name}: ${f.message}`));
  }
  if (queued) {
    toast.success(queued === 1 ? "Reading 1 doc" : `Reading ${queued} docs`, {
      description: duplicates ? `${duplicates} already captured, so skipped` : undefined,
    });
  } else if (duplicates) {
    toast.info(duplicates === 1 ? "That doc was already captured" : `Those ${duplicates} docs were already captured`);
  }
  if (failures.length) {
    toast.error(failures.length === 1 ? failures[0]! : `${failures.length} docs couldn’t be read`, {
      description: failures.length > 1 ? failures.slice(0, 3).join(" · ") : undefined,
    });
  }
  return queued;
}

/**
 * The Drive & OneDrive tab: Orbit's own browser over the person's recent docs — search, tick
 * one or many, Extract. Docs the scan flagged as meeting notes come first. Also opens the
 * review dialog when the toast or the bell sends someone here with `?review=1`.
 */
export function CloudNotesPicker({
  state,
  openReview = false,
  panelId,
  tabId,
  onQueued,
}: {
  state: CloudNotesState;
  openReview?: boolean;
  panelId: string;
  tabId: string;
  onQueued: () => void;
}) {
  const router = useRouter();
  const granted = state.drives.filter((d) => d.granted);
  const [provider, setProvider] = useState<CloudProvider>(granted[0]?.provider ?? "google");
  const drive = state.drives.find((d) => d.provider === provider)!;
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<PickerFile[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, Pickable>>(new Map());
  const [loading, startLoading] = useTransition();
  const [working, startWorking] = useTransition();
  const [autoExtract, setAutoExtract] = useState(state.autoExtract);
  const [reviewOpen, setReviewOpen] = useState(openReview && state.found.length > 0);

  // The list: recent docs, or a name search, re-read 300ms after typing stops.
  useEffect(() => {
    if (!drive.granted) return;
    const timer = setTimeout(
      () => {
        startLoading(async () => {
          const res = await listCloudNoteFiles({ provider, query: query.trim() || undefined });
          if (res.ok) {
            setFiles(res.value.files);
            setNext(res.value.next);
            setError(null);
          } else {
            setFiles([]);
            setNext(null);
            setError(res.error);
          }
        });
      },
      query ? 300 : 0,
    );
    return () => clearTimeout(timer);
  }, [provider, query, drive.granted]);

  const foundHere = useMemo(() => state.found.filter((f) => f.provider === provider), [state.found, provider]);
  const foundIds = useMemo(() => new Set(foundHere.map((f) => f.fileId)), [foundHere]);
  const rest = (files ?? []).filter((f) => !foundIds.has(f.id));

  function toggle(item: Pickable, on: boolean) {
    setSelected((prev) => {
      const nextSel = new Map(prev);
      const key = `${item.provider}:${item.id}`;
      if (on && nextSel.size < MAX_PICK) nextSel.set(key, item);
      else nextSel.delete(key);
      return nextSel;
    });
  }

  function extract(picked: Pickable[], done?: () => void) {
    startWorking(async () => {
      try {
        const queued = await extractPicked(picked);
        if (queued) {
          setSelected(new Map());
          onQueued();
        }
        done?.();
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t read those docs — try again"));
      }
    });
  }

  function connect(p: CloudProvider) {
    startWorking(async () => {
      try {
        const returnTo = "/capture?mode=cloud";
        const { url } =
          p === "google"
            ? await startGmailOAuth({ purpose: "drive_scan", returnTo })
            : await startOutlookOAuth({ purposes: ["files"], returnTo });
        window.location.assign(url);
      } catch (err) {
        toast.error(friendlyError(err, `Couldn’t connect ${DRIVE_LABEL[p]} — try again`));
      }
    });
  }

  function checkNow() {
    startWorking(async () => {
      const res = await checkCloudNotesNow();
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const n = res.value.found;
      toast.message(n === 0 ? "No new meeting notes" : `Found ${n} new meeting ${n === 1 ? "note" : "notes"}`, { keep: false });
      router.refresh();
    });
  }

  function toggleAuto() {
    const nextValue = !autoExtract;
    setAutoExtract(nextValue);
    startWorking(async () => {
      const res = await saveCloudNotesAutoExtract(nextValue);
      if (!res.ok) {
        setAutoExtract(!nextValue);
        toast.error(res.error);
      }
    });
  }

  function loadMore() {
    if (!next) return;
    startLoading(async () => {
      const res = await listCloudNoteFiles({ provider, query: query.trim() || undefined, pageToken: next });
      if (res.ok) {
        setFiles((prev) => [...(prev ?? []), ...res.value.files]);
        setNext(res.value.next);
      } else toast.error(res.error);
    });
  }

  const picked = [...selected.values()];

  return (
    <div id={panelId} role="tabpanel" aria-labelledby={tabId} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="radiogroup" aria-label="Drive" className="inline-flex rounded-lg bg-muted p-[3px]">
          {state.drives.map((d) => (
            <button
              key={d.provider}
              type="button"
              role="radio"
              aria-checked={provider === d.provider}
              onClick={() => {
                setProvider(d.provider);
                setFiles(null);
                setNext(null);
              }}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                provider === d.provider ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {DRIVE_LABEL[d.provider]}
            </button>
          ))}
        </div>
        {granted.length > 0 && (
          <Button type="button" variant="ghost" size="sm" disabled={working} onClick={checkNow}>
            <RefreshCw className={cn("size-4", working && "animate-spin")} />
            Check now
          </Button>
        )}
      </div>

      {!drive.granted ? (
        <div className="rounded-xl border border-dashed border-border/70 p-6 text-center">
          <FileText className="mx-auto mb-2 size-6 text-muted-foreground" />
          <p className="font-medium text-ink">
            {drive.connected ? `Allow Orbit to read ${DRIVE_LABEL[provider]}` : `Connect ${DRIVE_LABEL[provider]}`}
          </p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Orbit lists your recent docs so you can pick notes here, and checks new ones for meeting notes. It reads a whole doc
            only when you extract it, and never changes anything in your drive.
          </p>
          <Button type="button" className="mt-4" disabled={working} onClick={() => connect(provider)}>
            {working && <Loader2 className="size-4 animate-spin" />}
            {drive.connected ? "Allow access" : `Connect ${DRIVE_LABEL[provider]}`}
          </Button>
        </div>
      ) : (
        <>
          {drive.lastError && (
            <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/[0.04] px-3 py-2 text-sm">
              {drive.lastError}
            </p>
          )}
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${DRIVE_LABEL[provider]} by name`}
              aria-label={`Search ${DRIVE_LABEL[provider]}`}
              className="pl-9"
            />
          </div>

          {!query && foundHere.length > 0 && (
            <FileList
              title="Looks like meeting notes"
              items={foundHere.map((f) => ({ ...fromFound(f), hint: f.reason, status: null }))}
              selected={selected}
              onToggle={toggle}
            />
          )}

          {files === null || (loading && files.length === 0) ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading your docs…
            </div>
          ) : error ? (
            <p className="py-6 text-sm text-muted-foreground">{error}</p>
          ) : rest.length === 0 && foundHere.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">{query ? "No docs with that name" : "No recent docs"}</p>
          ) : rest.length > 0 ? (
            <FileList
              title={query ? "Matching docs" : "Recent docs"}
              items={rest.map((f) => ({
                provider: f.provider,
                id: f.id,
                name: f.name,
                webUrl: f.webUrl,
                modifiedTime: f.modifiedTime,
                hint: f.reason,
                status: f.status,
              }))}
              selected={selected}
              onToggle={toggle}
            />
          ) : null}
          {next && (
            <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={loadMore}>
              {loading && <Loader2 className="size-4 animate-spin" />}
              Load more
            </Button>
          )}

          <div className="sticky bottom-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-popover/95 px-3 py-2 shadow-sm backdrop-blur">
            <div className="flex items-center gap-2 text-sm">
              <button
                type="button"
                role="switch"
                aria-checked={autoExtract}
                aria-labelledby="cloud-notes-auto-label"
                disabled={working}
                onClick={toggleAuto}
                className={cn(
                  "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50",
                  autoExtract ? "bg-primary" : "bg-muted-foreground/30",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "pointer-events-none size-4 rounded-full bg-background shadow-sm transition-transform",
                    autoExtract ? "translate-x-[18px]" : "translate-x-0.5",
                  )}
                />
              </button>
              <span id="cloud-notes-auto-label">Auto-extract new meeting notes</span>
            </div>
            <Button type="button" disabled={picked.length === 0 || working} onClick={() => extract(picked)}>
              {working && <Loader2 className="size-4 animate-spin" />}
              {picked.length ? `Extract ${picked.length}` : "Extract"}
            </Button>
          </div>
        </>
      )}

      {state.found.length > 0 && (
        <ReviewDialog open={reviewOpen} onOpenChange={setReviewOpen} found={state.found} working={working} onExtract={extract} />
      )}
    </div>
  );
}

function FileList({
  title,
  items,
  selected,
  onToggle,
}: {
  title: string;
  items: Array<Pickable & { hint: string | null; status: PickerFile["status"] }>;
  selected: Map<string, Pickable>;
  onToggle: (item: Pickable, on: boolean) => void;
}) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      <ul className="divide-y rounded-xl border">
        {items.map((f) => {
          const key = `${f.provider}:${f.id}`;
          const done = f.status === "queued";
          return (
            <li key={key}>
              <label className={cn("flex items-center gap-3 px-3 py-2.5", done ? "opacity-60" : "cursor-pointer hover:bg-muted/40")}>
                <Checkbox
                  checked={selected.has(key)}
                  disabled={done}
                  onCheckedChange={(on) => onToggle(f, on === true)}
                  aria-label={`Select ${f.name}`}
                />
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{f.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {f.modifiedTime ? `Edited ${formatDistanceToNow(new Date(f.modifiedTime), { addSuffix: true })}` : ""}
                    {done ? " · Already extracted" : f.hint ? ` · ${f.hint}` : ""}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Every doc the scan flagged, all ticked: extract them in one go, or dismiss them for good. */
function ReviewDialog({
  open,
  onOpenChange,
  found,
  working,
  onExtract,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  found: FoundCloudNote[];
  working: boolean;
  onExtract: (picked: Pickable[], done?: () => void) => void;
}) {
  const router = useRouter();
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(found.slice(0, MAX_PICK).map((f) => f.id)));
  const [dismissing, startDismiss] = useTransition();
  const chosen = found.filter((f) => ticked.has(f.id));

  function dismissAll() {
    startDismiss(async () => {
      const res = await dismissCloudNotes(found.map((f) => f.id));
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      onOpenChange(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {found.length === 1 ? "1 doc looks like meeting notes" : `${found.length} docs look like meeting notes`}
          </DialogTitle>
          <DialogDescription>
            Orbit reads each one you keep ticked and pulls out the people in it. You review them before anything is saved.
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-[50vh] divide-y overflow-y-auto rounded-xl border">
          {found.map((f) => (
            <li key={f.id}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-muted/40">
                <Checkbox
                  checked={ticked.has(f.id)}
                  onCheckedChange={(on) =>
                    setTicked((prev) => {
                      const nextSet = new Set(prev);
                      if (on === true && nextSet.size < MAX_PICK) nextSet.add(f.id);
                      else nextSet.delete(f.id);
                      return nextSet;
                    })
                  }
                  aria-label={`Extract ${f.name}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{f.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {DRIVE_LABEL[f.provider]}
                    {f.modifiedAt ? ` · ${formatDistanceToNow(new Date(f.modifiedAt), { addSuffix: true })}` : ""}
                    {f.reason ? ` · ${f.reason}` : ""}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={dismissing || working} onClick={dismissAll}>
            Not notes — dismiss all
          </Button>
          <Button
            type="button"
            disabled={chosen.length === 0 || working}
            onClick={() => onExtract(chosen.map(fromFound), () => onOpenChange(false))}
          >
            {working && <Loader2 className="size-4 animate-spin" />}
            {chosen.length === found.length ? "Extract all" : `Extract ${chosen.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
