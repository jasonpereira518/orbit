"use client";

/**
 * "From Notion" in the Notes library: pick pages the person shared with Orbit and extract them.
 * Each page becomes one capture job (`queueNotionPage`) and lands in the review cards like a
 * Drive doc — nothing saves on its own.
 *
 * Not connected yet: the button starts Notion's consent screen and comes back here with the
 * picker open (`?notion=pick`). Shown only where the Notion surface is released (`show`).
 */
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { Loader2, Search } from "lucide-react";
import {
  getNotionPickable,
  getNotionPickerState,
  queueNotionPage,
  startNotionConnect,
} from "@/actions/notion";
import type { NotionPickable } from "@/lib/connectors/notion";
import { NotionMark } from "@/components/settings/provider-marks";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";

const CONCURRENCY = 2;
const MAX_PICK = 25;
const RETURN_TO = "/capture?mode=library&notion=pick";

function newBatchId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function NotionCaptureButton({
  show,
  disabled = false,
  onQueued,
}: {
  show: boolean;
  disabled?: boolean;
  onQueued: (jobIds: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [checking, startCheck] = useTransition();
  const reopened = useRef(false);
  const pickParam = useSearchParams().get("notion") === "pick";

  const openPicker = useCallback(() => {
    startCheck(async () => {
      try {
        const state = await getNotionPickerState();
        if (state.state === "connected") {
          setOpen(true);
          return;
        }
        const res = await startNotionConnect(RETURN_TO);
        if (!res.ok) return void toast.error(res.error);
        window.location.assign(res.value.url);
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t reach Notion — try again?"));
      }
    });
  }, []);

  // Back from Notion's consent screen: open the picker once.
  useEffect(() => {
    if (!pickParam || reopened.current || !show) return;
    reopened.current = true;
    openPicker();
  }, [pickParam, show, openPicker]);

  if (!show) return null;

  return (
    <>
      <Button type="button" variant="outline" size="sm" disabled={disabled || checking} onClick={openPicker}>
        {checking ? <Loader2 className="size-4 animate-spin" /> : <NotionMark className="size-4" />}
        From Notion
      </Button>
      {open && <NotionPickerDialog onClose={() => setOpen(false)} onQueued={onQueued} />}
    </>
  );
}

function NotionPickerDialog({ onClose, onQueued }: { onClose: () => void; onQueued: (jobIds: string[]) => void }) {
  const [query, setQuery] = useState("");
  const [pages, setPages] = useState<NotionPickable[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Map<string, NotionPickable>>(new Map());
  const [working, setWorking] = useState(false);

  const load = useCallback((q: string, cursor: string | null) => {
    setLoading(true);
    void getNotionPickable(q, cursor)
      .catch(() => null)
      .then((res) => {
        if (!res || !res.ok) {
          setLoadError(res && !res.ok ? res.error : "Couldn’t load your Notion pages — try again?");
        } else {
          setLoadError(null);
          setPages((prev) => (cursor ? [...prev, ...res.value.pages.filter((p) => !prev.some((x) => x.id === p.id))] : res.value.pages));
          setNext(res.value.nextCursor);
        }
        setLoading(false);
      });
  }, []);

  // Searching waits for a pause in typing; the first load runs at once.
  useEffect(() => {
    const timer = setTimeout(() => load(query.trim(), null), query ? 300 : 0);
    return () => clearTimeout(timer);
  }, [query, load]);

  async function extract() {
    const picked = [...ticked.values()];
    if (!picked.length || working) return;
    setWorking(true);
    const batchGroupId = newBatchId();
    const jobIds: string[] = [];
    const failures: string[] = [];
    let duplicates = 0;
    let i = 0;
    const worker = async () => {
      while (i < picked.length) {
        const page = picked[i++];
        try {
          const res = await queueNotionPage({ pageId: page.id, batchGroupId });
          if (!res.ok) failures.push(`${page.title}: ${res.error}`);
          else if (res.value.status === "duplicate") duplicates += 1;
          else jobIds.push(res.value.jobId);
        } catch (err) {
          failures.push(`${page.title}: ${friendlyError(err, "couldn’t be read")}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, picked.length) }, worker));
    setWorking(false);

    if (jobIds.length) {
      toast.success(jobIds.length === 1 ? "Reading 1 Notion page" : `Reading ${jobIds.length} Notion pages`, {
        description: "The people in them will be ready to review in a moment",
      });
      onQueued(jobIds);
    } else if (duplicates) {
      toast.info(duplicates === 1 ? "That page is already in Orbit" : "Those pages are already in Orbit");
    }
    if (failures.length) toast.error(failures[0], failures.length > 1 ? { description: `and ${failures.length - 1} more` } : undefined);
    if (!failures.length) onClose();
  }

  const empty = !loading && !loadError && pages.length === 0;

  return (
    <Dialog open onOpenChange={(o) => !o && !working && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <NotionMark className="size-5" />
            Pages from Notion
          </DialogTitle>
          <DialogDescription>
            Pick the pages to extract. You review the people in them before anything saves.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your shared pages"
            aria-label="Search Notion pages"
            className="pl-8"
          />
        </div>

        {loadError && !pages.length ? (
          <div className="space-y-2 text-sm">
            <p className="text-destructive">{loadError}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => load(query.trim(), null)}>
              Try again
            </Button>
          </div>
        ) : empty ? (
          <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
            {query
              ? "No shared page matches that."
              : "No pages shared with Orbit yet. Reconnect Notion from Settings → Integrations → Notion to choose some."}
          </p>
        ) : (
          <ul className="max-h-[50dvh] divide-y overflow-y-auto rounded-xl border">
            {pages.map((p) => (
              <li key={p.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-muted/40">
                  <Checkbox
                    checked={ticked.has(p.id)}
                    disabled={working}
                    onCheckedChange={(on) =>
                      setTicked((prev) => {
                        const nextMap = new Map(prev);
                        if (on === true && nextMap.size < MAX_PICK) nextMap.set(p.id, p);
                        else nextMap.delete(p.id);
                        return nextMap;
                      })
                    }
                    aria-label={`Extract ${p.title}`}
                  />
                  <span aria-hidden className="w-5 shrink-0 text-center">{p.icon ?? "📄"}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">{p.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      Edited {formatDistanceToNow(new Date(p.editedAt), { addSuffix: true })}
                    </span>
                  </span>
                </label>
              </li>
            ))}
            {loading && (
              <li className="flex items-center gap-2 px-3 py-2.5 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading your pages…
              </li>
            )}
          </ul>
        )}

        {next && !loading && (
          <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => load(query.trim(), next)}>
            Load more
          </Button>
        )}

        <div className="flex items-center justify-end border-t pt-3">
          <Button type="button" disabled={ticked.size === 0 || working} onClick={() => void extract()}>
            {working && <Loader2 className="size-4 animate-spin" />}
            {ticked.size ? `Extract ${ticked.size}` : "Extract"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
