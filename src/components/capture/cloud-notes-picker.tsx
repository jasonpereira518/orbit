"use client";

import { format, formatDistanceToNow } from "date-fns";
import { Check, Eye, FileText, LayoutGrid, List, Loader2, RefreshCw, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import {
  checkCloudNotesNow,
  cloudNoteThumbnails,
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
import { CloudNotePeek, type PeekFile } from "@/components/capture/cloud-note-peek";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PROVIDER_THEMES } from "@/components/settings/provider-themes";
import type { CloudProvider } from "@/lib/cloud-files";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const DRIVE_LABEL: Record<CloudProvider, string> = { google: "Google Drive", microsoft: "OneDrive" };
const MAX_PICK = 25;
const THUMB_BATCH = 30;

type Pickable = { provider: CloudProvider; id: string; name: string; webUrl: string | null; modifiedTime: string | null };
/** One doc as the grid and list show it. `done` means it's already been extracted. */
type Item = PeekFile & { hint: string | null };

const keyOf = (f: { provider: CloudProvider; id: string }) => `${f.provider}:${f.id}`;

function fromFound(f: FoundCloudNote): Pickable {
  return { provider: f.provider, id: f.fileId, name: f.name, webUrl: f.webUrl, modifiedTime: f.modifiedAt };
}

// Grid or list, remembered per browser like Drive's own toggle.
type View = "grid" | "list";
const VIEW_KEY = "orbit:cloud-notes-view";
const viewListeners = new Set<() => void>();
function subscribeView(cb: () => void) {
  viewListeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    viewListeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}
function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}
function writeView(view: View) {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Private mode: the toggle still works for this visit.
  }
  viewListeners.forEach((l) => l());
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
 * The Drive & OneDrive tab, laid out like Drive itself: a search pill, Suggested (the scan's
 * meeting-note finds) above Recent, a grid of page-one thumbnails or a Name / Owner / Last
 * modified list, and Drive's selection bar. Click selects, double-click or Enter peeks.
 * Also opens the review dialog when the toast or the bell sends someone here with `?review=1`.
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
  const [selected, setSelected] = useState<Map<string, Item>>(new Map());
  const [loading, startLoading] = useTransition();
  const [working, startWorking] = useTransition();
  const [autoExtract, setAutoExtract] = useState(state.autoExtract);
  const [reviewOpen, setReviewOpen] = useState(openReview && state.found.length > 0);
  const [peek, setPeek] = useState<Item | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({});
  const requested = useRef(new Set<string>());
  const view = useSyncExternalStore(subscribeView, readView, (): View => "grid");

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

  const foundItems = useMemo<Item[]>(
    () =>
      state.found
        .filter((f) => f.provider === provider)
        .map((f) => ({ ...fromFound(f), owner: null, hint: f.reason, done: false })),
    [state.found, provider],
  );
  const restItems = useMemo<Item[]>(() => {
    const foundIds = new Set(foundItems.map((f) => f.id));
    return (files ?? [])
      .filter((f) => !foundIds.has(f.id))
      .map((f) => ({
        provider: f.provider,
        id: f.id,
        name: f.name,
        webUrl: f.webUrl,
        modifiedTime: f.modifiedTime,
        owner: f.owner ?? null,
        hint: f.reason,
        done: f.status === "queued",
      }));
  }, [files, foundItems]);

  // Page-one thumbnails for whatever the grid shows, asked for once per doc in page-sized batches.
  useEffect(() => {
    if (view !== "grid") return;
    const want = [...foundItems, ...restItems].filter((f) => !requested.current.has(keyOf(f)));
    for (const f of want) requested.current.add(keyOf(f));
    for (let i = 0; i < want.length; i += THUMB_BATCH) {
      const batch = want.slice(i, i + THUMB_BATCH);
      void cloudNoteThumbnails({ provider: batch[0]!.provider, files: batch.map((f) => ({ id: f.id, name: f.name })) })
        .then((res) => (res.ok ? res.value : {}))
        .catch((): Record<string, string | null> => ({}))
        .then((byId) =>
          setThumbs((prev) => {
            const nextThumbs = { ...prev };
            for (const f of batch) nextThumbs[keyOf(f)] = byId[f.id] ?? null;
            return nextThumbs;
          }),
        );
    }
  }, [view, foundItems, restItems]);

  function toggle(item: Item, on: boolean) {
    setSelected((prev) => {
      const nextSel = new Map(prev);
      if (on && nextSel.size < MAX_PICK) nextSel.set(keyOf(item), item);
      else nextSel.delete(keyOf(item));
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
  const shared = { view, selected, thumbs, onToggle: toggle, onPeek: setPeek };
  const ms = provider === "microsoft";
  const theme = PROVIDER_THEMES[provider].className;

  return (
    <div id={panelId} role="tabpanel" aria-labelledby={tabId} className={cn("space-y-4", theme)}>
      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="Drive" className="inline-flex shrink-0 rounded-full bg-muted p-[3px]">
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
                setSelected(new Map());
              }}
              className={cn(
                "rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
                provider === d.provider ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {DRIVE_LABEL[d.provider]}
            </button>
          ))}
        </div>
        {drive.granted && (
          <div className="relative order-last w-full sm:order-none sm:w-auto sm:flex-1">
            <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search in ${DRIVE_LABEL[provider]}`}
              aria-label={`Search ${DRIVE_LABEL[provider]}`}
              className={cn(
                "pl-11 pr-10",
                // Drive's search is a filled pill; OneDrive's a white box with a hairline border.
                ms
                  ? "h-10 rounded-md border-input bg-background shadow-xs"
                  : "h-11 rounded-full border-transparent bg-muted shadow-none focus-visible:bg-background",
              )}
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
        )}
        {granted.length > 0 && (
          <Button type="button" variant="ghost" size="sm" className="ml-auto sm:ml-0" disabled={working} onClick={checkNow}>
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
            Orbit lists your recent docs so you can pick notes here, and checks new ones for meeting notes. It reads a doc only
            when you preview or extract it, and never changes anything in your drive.
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

          {/* Drive's toolbar row: view options at rest, the selection bar once anything is picked. */}
          <div
            className={cn(
              "flex min-h-11 flex-wrap items-center justify-between gap-2 px-1.5",
              ms ? "rounded-md" : "rounded-full",
              picked.length > 0 && "sticky top-3 z-10 bg-popover/95 py-1 shadow-sm ring-1 ring-border backdrop-blur",
            )}
          >
            {picked.length > 0 ? (
              <>
                <div className="flex items-center gap-1">
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Clear selection" onClick={() => setSelected(new Map())}>
                    <X className="size-4" />
                  </Button>
                  <span className="text-sm font-medium" aria-live="polite">
                    {picked.length} selected
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {picked.length === 1 && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setPeek(picked[0]!)}>
                      <Eye className="size-4" />
                      Preview
                    </Button>
                  )}
                  <Button type="button" size="sm" disabled={working} onClick={() => extract(picked)}>
                    {working && <Loader2 className="size-4 animate-spin" />}
                    Extract {picked.length}
                  </Button>
                </div>
              </>
            ) : (
              <>
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
                  <span id="cloud-notes-auto-label" className="text-muted-foreground">
                    Auto-extract new meeting notes
                  </span>
                </div>
                <div role="radiogroup" aria-label="Layout" className="inline-flex rounded-full border p-0.5">
                  {(
                    [
                      ["grid", LayoutGrid, "Grid view"],
                      ["list", List, "List view"],
                    ] as const
                  ).map(([value, Icon, label]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={view === value}
                      aria-label={label}
                      onClick={() => writeView(value)}
                      className={cn(
                        "grid h-7 min-w-9 place-items-center rounded-full px-2 transition-colors",
                        view === value ? "bg-primary/15 text-foreground" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <span className="flex items-center gap-0.5">
                        {view === value && <Check className="size-3.5" />}
                        <Icon className="size-4" />
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {!query && foundItems.length > 0 && (
            <DocSection title="Suggested" subtitle="Looks like meeting notes" items={foundItems} {...shared} />
          )}

          {files === null || (loading && files.length === 0) ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading your docs…
            </div>
          ) : error ? (
            <p className="py-6 text-sm text-muted-foreground">{error}</p>
          ) : restItems.length === 0 && foundItems.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">{query ? "No docs with that name" : "No recent docs"}</p>
          ) : restItems.length > 0 ? (
            <DocSection title={query ? "Results" : "Recent"} items={restItems} {...shared} />
          ) : null}
          {next && (
            <Button type="button" variant="ghost" size="sm" disabled={loading} onClick={loadMore}>
              {loading && <Loader2 className="size-4 animate-spin" />}
              Load more
            </Button>
          )}
        </>
      )}

      <CloudNotePeek
        className={theme}
        file={peek}
        thumbnail={peek ? thumbs[keyOf(peek)] : null}
        working={working}
        onClose={() => setPeek(null)}
        onExtract={(f) => extract([f], () => setPeek(null))}
      />

      {state.found.length > 0 && (
        <ReviewDialog open={reviewOpen} onOpenChange={setReviewOpen} found={state.found} working={working} onExtract={extract} />
      )}
    </div>
  );
}

type SectionProps = {
  view: View;
  items: Item[];
  selected: Map<string, Item>;
  thumbs: Record<string, string | null>;
  onToggle: (item: Item, on: boolean) => void;
  onPeek: (item: Item) => void;
};

/** Google Docs' blue page, Word's W, or a plain page for OneDrive text and transcripts. */
function DocIcon({ item, className }: { item: Pick<Item, "provider" | "name">; className?: string }) {
  const base = "grid size-5 shrink-0 place-items-center rounded-[4px] text-white";
  if (item.provider === "google") {
    return (
      <span aria-hidden className={cn(base, "bg-[#4285F4]", className)}>
        <FileText className="size-3.5" strokeWidth={2.25} />
      </span>
    );
  }
  if (item.name.toLowerCase().endsWith(".docx")) {
    return (
      <span aria-hidden className={cn(base, "bg-[#185ABD] text-[11px] font-bold leading-none", className)}>
        W
      </span>
    );
  }
  return (
    <span aria-hidden className={cn(base, "bg-muted-foreground/70", className)}>
      <FileText className="size-3.5" strokeWidth={2.25} />
    </span>
  );
}

/** Selected docs swap their icon for a check, as Drive does. */
function DocMark({ item, on }: { item: Item; on: boolean }) {
  return on ? (
    <span aria-hidden className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
      <Check className="size-3.5" strokeWidth={3} />
    </span>
  ) : (
    <DocIcon item={item} />
  );
}

function metaLine(f: Item): string {
  if (f.done) return "Already extracted";
  if (f.hint) return f.hint;
  if (!f.modifiedTime) return "";
  if (f.provider === "microsoft") return `Modified ${format(new Date(f.modifiedTime), "MMM d")}`;
  return `${f.owner === "You" ? "You edited" : "Edited"} ${formatDistanceToNow(new Date(f.modifiedTime), { addSuffix: true })}`;
}

/**
 * The whole card or row is one button — click toggles, double-click or Enter peeks — with the
 * preview button as a sibling above it, so no control sits inside another.
 */
function cardButtonProps(f: Item, on: boolean, onToggle: SectionProps["onToggle"], onPeek: SectionProps["onPeek"]) {
  return {
    type: "button" as const,
    "aria-pressed": f.done ? undefined : on,
    "aria-label": f.done ? `${f.name}, already extracted` : f.name,
    onClick: () => (f.done ? onPeek(f) : onToggle(f, !on)),
    onDoubleClick: () => onPeek(f),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onPeek(f);
      }
    },
  };
}

function PeekButton({ f, onPeek, className }: { f: Item; onPeek: SectionProps["onPeek"]; className?: string }) {
  return (
    <button
      type="button"
      aria-label={`Preview ${f.name}`}
      onClick={() => onPeek(f)}
      className={cn(
        "pointer-events-auto relative z-10 grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100",
        className,
      )}
    >
      <Eye className="size-4" />
    </button>
  );
}

function DocSection({ title, subtitle, ...props }: SectionProps & { title: string; subtitle?: string }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium text-ink">
        {title}
        {subtitle && <span className="font-normal text-muted-foreground"> · {subtitle}</span>}
      </h3>
      {props.view === "grid" ? <DocGrid {...props} /> : <DocList {...props} />}
    </section>
  );
}

function Thumb({ f, thumb }: { f: Item; thumb: string | null | undefined }) {
  return thumb ? (
    // eslint-disable-next-line @next/next/no-img-element -- a data: URL or a short-lived provider URL; next/image can't optimize either
    <img src={thumb} alt="" loading="lazy" className="size-full bg-white object-cover object-top" />
  ) : thumb === undefined ? (
    <span aria-hidden className="absolute inset-0 animate-pulse bg-muted/70" />
  ) : (
    <span aria-hidden className="absolute inset-0 grid place-items-center">
      <DocIcon item={f} className="size-10 rounded-md text-lg [&_svg]:size-6" />
    </span>
  );
}

/** OneDrive's tiles: thumbnail on top, name and date under it, a round check in the corner. */
function OneDriveGrid({ items, selected, thumbs, onToggle, onPeek }: SectionProps) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {items.map((f) => {
        const key = keyOf(f);
        const on = selected.has(key);
        return (
          <li
            key={key}
            className={cn(
              "group relative overflow-hidden rounded-md border bg-card transition-shadow",
              on ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:shadow-md",
              f.done && "opacity-60",
            )}
          >
            <button
              {...cardButtonProps(f, on, onToggle, onPeek)}
              className="absolute inset-0 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            <div className="pointer-events-none relative">
              <div className="relative aspect-[4/3] overflow-hidden bg-muted/50">
                <Thumb f={f} thumb={thumbs[key]} />
                <PeekButton f={f} onPeek={onPeek} className="absolute left-1.5 top-1.5 bg-background/90 shadow-sm" />
                {!f.done && (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute right-2 top-2 grid size-5 place-items-center rounded-full border-2 transition-opacity",
                      on
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-white bg-black/25 opacity-0 group-hover:opacity-100 [@media(hover:none)]:hidden",
                    )}
                  >
                    {on && <Check className="size-3" strokeWidth={3} />}
                  </span>
                )}
              </div>
              <div className="flex min-w-0 items-start gap-2 border-t p-2.5">
                <DocIcon item={f} className="mt-px" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink">{f.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{metaLine(f) || "\u00a0"}</span>
                </span>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function DocGrid(props: SectionProps) {
  if (props.items[0]?.provider === "microsoft") return <OneDriveGrid {...props} />;
  const { items, selected, thumbs, onToggle, onPeek } = props;
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {items.map((f) => {
        const key = keyOf(f);
        const on = selected.has(key);
        const thumb = thumbs[key];
        return (
          <li
            key={key}
            className={cn(
              "group relative rounded-xl p-2 transition-colors",
              on ? "bg-primary/10 ring-2 ring-primary" : "bg-muted/60 hover:bg-muted",
              f.done && "opacity-60",
            )}
          >
            <button
              {...cardButtonProps(f, on, onToggle, onPeek)}
              className="absolute inset-0 rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            <div className="pointer-events-none relative flex flex-col gap-2">
              <div className="flex min-w-0 items-center gap-2 pl-1">
                <DocMark item={f} on={on} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{f.name}</span>
              </div>
              <div className="relative aspect-[4/3] overflow-hidden rounded-lg bg-background">
                <Thumb f={f} thumb={thumb} />
                <PeekButton f={f} onPeek={onPeek} className="absolute right-1.5 top-1.5 bg-background/90 shadow-sm" />
              </div>
              <p className="truncate px-1 text-xs text-muted-foreground">{metaLine(f) || " "}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function DocList({ items, selected, onToggle, onPeek }: SectionProps) {
  const ms = items[0]?.provider === "microsoft";
  const cols = ms
    ? "grid grid-cols-[minmax(0,1fr)_auto_1.75rem] items-center gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_10rem_1.75rem]"
    : "grid grid-cols-[minmax(0,1fr)_auto_1.75rem] items-center gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_8rem_1.75rem]";
  const owner = (f: Item) => <span className="hidden truncate text-sm text-muted-foreground sm:block">{f.owner ?? "—"}</span>;
  const modified = (f: Item) => (
    <span className="text-sm text-muted-foreground">{f.modifiedTime ? format(new Date(f.modifiedTime), "MMM d, yyyy") : "—"}</span>
  );
  return (
    <div className={ms ? "" : "rounded-xl border"}>
      <div aria-hidden className={cn(cols, "border-b px-3 py-2 text-xs font-medium text-muted-foreground")}>
        <span>Name</span>
        {ms ? (
          <>
            <span>Modified</span>
            <span className="hidden sm:block">Owner</span>
          </>
        ) : (
          <>
            <span className="hidden sm:block">Owner</span>
            <span>Last modified</span>
          </>
        )}
        <span />
      </div>
      <ul className={ms ? "" : "divide-y"}>
        {items.map((f) => {
          const key = keyOf(f);
          const on = selected.has(key);
          return (
            <li
              key={key}
              className={cn("group relative", ms && "rounded-md", on ? "bg-primary/10" : "hover:bg-muted/50", f.done && "opacity-60")}
            >
              <button
                {...cardButtonProps(f, on, onToggle, onPeek)}
                className="absolute inset-0 outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50"
              />
              <div className={cn(cols, "pointer-events-none relative px-3 py-2")}>
                <span className="flex min-w-0 items-center gap-3">
                  <DocMark item={f} on={on} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">{f.name}</span>
                    {(f.done || f.hint) && <span className="block truncate text-xs text-muted-foreground">{metaLine(f)}</span>}
                  </span>
                </span>
                {ms ? (
                  <>
                    {modified(f)}
                    {owner(f)}
                  </>
                ) : (
                  <>
                    {owner(f)}
                    {modified(f)}
                  </>
                )}
                <PeekButton f={f} onPeek={onPeek} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
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
        <ul className="max-h-[50dvh] divide-y overflow-y-auto rounded-xl border">
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
