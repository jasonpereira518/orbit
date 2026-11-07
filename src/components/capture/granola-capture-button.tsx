"use client";

/**
 * "From Granola" in the Notes library: pick notes from your Granola account and extract them,
 * or let new ones be extracted automatically.
 *
 * A picked note becomes one capture job (`queueGranolaCapture`). Its runner saves the people
 * already in Orbit straight away and leaves new people for the review cards — so the queue
 * below shows a job only when there is someone to look at. The switch is the same automatic
 * sync Settings → Integrations → Granola describes; turning it back on starts from now.
 *
 * Not connected yet: the button starts Granola's sign-in and comes back here with the picker
 * open (`?granola=pick`).
 */
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { format } from "date-fns";
import { Loader2 } from "lucide-react";
import {
  getGranolaPickable,
  getGranolaPickerState,
  queueGranolaCapture,
  setGranolaAutoExtract,
  startGranolaConnect,
  type GranolaPickerState,
} from "@/actions/granola";
import type { GranolaPickable } from "@/lib/connectors/granola";
import { GranolaMark } from "@/components/settings/provider-marks";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const CONCURRENCY = 2;
const MAX_PICK = 25;
// The Notes library tab, so the button (and the picker it reopens) is mounted on arrival.
const RETURN_TO = "/capture?mode=library&granola=pick";

function newBatchId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Null when the plan has no sync, like the Drive button beside it. */
export function GranolaCaptureButton({
  canUseSync,
  disabled = false,
  onQueued,
}: {
  canUseSync: boolean;
  disabled?: boolean;
  /** The jobs this pick created, once every note has been queued. */
  onQueued: (jobIds: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [checking, startCheck] = useTransition();
  const reopened = useRef(false);
  const pickParam = useSearchParams().get("granola") === "pick";

  const openPicker = useCallback(() => {
    startCheck(async () => {
      try {
        const state = await getGranolaPickerState();
        if (state.state === "connected") {
          setOpen(true);
          return;
        }
        const { url } = await startGranolaConnect(RETURN_TO);
        window.location.assign(url);
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t reach Granola — try again?"));
      }
    });
  }, []);

  // Back from Granola's sign-in: open the picker once. The param stays in the URL on
  // purpose — rewriting it here would race the picker's first server action.
  useEffect(() => {
    if (!pickParam || reopened.current || !canUseSync) return;
    reopened.current = true;
    openPicker();
  }, [pickParam, canUseSync, openPicker]);

  if (!canUseSync) return null;

  return (
    <>
      <Button type="button" variant="outline" size="sm" disabled={disabled || checking} onClick={openPicker}>
        {checking ? <Loader2 className="size-4 animate-spin" /> : <GranolaMark className="size-4" />}
        From Granola
      </Button>
      {/* Mounted only while open, so each opening starts from a fresh list. */}
      {open && <GranolaPickerDialog onClose={() => setOpen(false)} onQueued={onQueued} />}
    </>
  );
}

function GranolaPickerDialog({ onClose, onQueued }: { onClose: () => void; onQueued: (jobIds: string[]) => void }) {
  const [state, setState] = useState<GranolaPickerState | null>(null);
  const [notes, setNotes] = useState<GranolaPickable[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);
  const [toggling, startToggle] = useTransition();

  const applyPage = useCallback((res: Awaited<ReturnType<typeof getGranolaPickable>> | null) => {
    if (!res || !res.ok) {
      setLoadError(res && !res.ok ? res.error : "Couldn’t load your Granola notes — try again?");
    } else {
      setLoadError(null);
      setNotes((prev) => [...prev, ...res.value.notes.filter((n) => !prev.some((p) => p.id === n.id))]);
      setNext(res.value.nextCursor);
    }
    setLoading(false);
  }, []);
  // Callers set `loading` first; it starts true for the first page.
  const loadPage = (cursor: string | null) => getGranolaPickable(cursor).catch(() => null).then(applyPage);

  useEffect(() => {
    getGranolaPickerState().then(setState, () => setState(null));
    getGranolaPickable(null).catch(() => null).then(applyPage);
  }, [applyPage]);

  const autoExtract = state?.state === "connected" && state.autoExtract;

  function toggleAuto() {
    const on = !autoExtract;
    startToggle(async () => {
      try {
        await setGranolaAutoExtract(on);
        setState({ state: "connected", autoExtract: on });
        toast.success(on ? "New Granola notes will be extracted automatically" : "Granola notes now come in only when you pick them");
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t change that — try again?"));
      }
    });
  }

  async function extract() {
    const picked = notes.filter((n) => ticked.has(n.id));
    if (!picked.length || working) return;
    setWorking(true);
    const batchGroupId = newBatchId();
    const jobIds: string[] = [];
    const failures: string[] = [];
    let duplicates = 0;
    let i = 0;
    const worker = async () => {
      while (i < picked.length) {
        const note = picked[i++]!;
        try {
          const res = await queueGranolaCapture({ noteId: note.id, batchGroupId });
          if (!res.ok) failures.push(`${note.title}: ${res.error}`);
          else if (res.value.status === "duplicate" || !res.value.jobId) duplicates += 1;
          else jobIds.push(res.value.jobId);
        } catch (err) {
          failures.push(`${note.title}: ${friendlyError(err, "couldn’t be read")}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, picked.length) }, worker));
    setWorking(false);

    if (jobIds.length) {
      toast.success(jobIds.length === 1 ? "Reading 1 Granola note" : `Reading ${jobIds.length} Granola notes`, {
        description: "People already in Orbit are updated right away; anyone new waits for you to review",
      });
      onQueued(jobIds);
    } else if (duplicates) {
      toast.info(duplicates === 1 ? "That note is already in Orbit" : "Those notes are already in Orbit");
    }
    if (failures.length) toast.error(failures[0]!, failures.length > 1 ? { description: `and ${failures.length - 1} more` } : undefined);
    if (!failures.length) onClose();
  }

  const empty = !loading && !loadError && notes.length === 0;

  return (
    <Dialog open onOpenChange={(o) => !o && !working && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GranolaMark className="size-5" />
            Notes from Granola
          </DialogTitle>
          <DialogDescription>
            Pick the notes to extract. People already in Orbit are updated right away; anyone new
            waits for you to review.
          </DialogDescription>
        </DialogHeader>

        {loadError && !notes.length ? (
          <div className="space-y-2 text-sm">
            <p className="text-destructive">{loadError}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => {
                setLoading(true);
                void loadPage(null);
              }}>
              Try again
            </Button>
          </div>
        ) : empty && !next ? (
          <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
            Everything from the last 30 days is already in Orbit.
          </p>
        ) : (
          <ul className="max-h-[50dvh] divide-y overflow-y-auto rounded-xl border">
            {notes.map((n) => (
              <li key={n.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-muted/40">
                  <Checkbox
                    checked={ticked.has(n.id)}
                    disabled={working}
                    onCheckedChange={(on) =>
                      setTicked((prev) => {
                        const nextSet = new Set(prev);
                        if (on === true && nextSet.size < MAX_PICK) nextSet.add(n.id);
                        else nextSet.delete(n.id);
                        return nextSet;
                      })
                    }
                    aria-label={`Extract ${n.title}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink">{n.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {format(new Date(n.meetingAt), "MMM d, h:mm a")}
                      {n.attendees.length ? ` · ${n.attendees.join(", ")}` : ""}
                    </span>
                  </span>
                </label>
              </li>
            ))}
            {loading && (
              <li className="flex items-center gap-2 px-3 py-2.5 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading your notes…
              </li>
            )}
          </ul>
        )}

        {next && !loading && (
          <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => {
            setLoading(true);
            void loadPage(next);
          }}>
            Load more
          </Button>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <div className="flex items-center gap-2 text-sm">
            <button
              type="button"
              role="switch"
              aria-checked={autoExtract}
              aria-labelledby="granola-auto-label"
              disabled={toggling || working || state?.state !== "connected"}
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
            <span id="granola-auto-label">Automatically extract new notes</span>
          </div>
          <Button type="button" disabled={ticked.size === 0 || working} onClick={() => void extract()}>
            {working && <Loader2 className="size-4 animate-spin" />}
            {ticked.size ? `Extract ${ticked.size}` : "Extract"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
