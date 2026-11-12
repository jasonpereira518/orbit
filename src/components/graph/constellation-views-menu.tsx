"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { ChevronDown, Loader2, MoreHorizontal, Plus } from "lucide-react";
import {
  createConstellation,
  deleteConstellation,
  renameConstellation,
} from "@/actions/custom-constellations";
// Type only: the module behind it reaches `@/db`, which must not enter the client bundle.
import type { ConstellationTab } from "@/lib/custom-constellations";
import { friendlyError } from "@/lib/errors";
import { awaitNewSky, startGenerating, stopGenerating } from "@/lib/graph/generating-signal";
import { FREE_CAP_COPY } from "@/lib/plans/plan-config";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";
import { cn } from "@/lib/utils";
import { CONTROL_SHELL } from "@/components/graph/constellation-scope-toggle";
import { Button, buttonVariants } from "@/components/ui/button";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";

const PROMPT_MAX = 300;
const NAME_MAX = 60;

const ROW =
  "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40";

/**
 * The star chart's view picker, beside Top | All on the title's row: "My network", each saved
 * constellation in the order it was made, then "New constellation". The selection lives in the
 * URL (`?c=<id>`), so rows are links and back/forward work.
 *
 * One popover, two steps: the list, and a compose step where the view is described in a
 * sentence. Submitting closes the popover and hands the wait to the stage's generating scene
 * (`generating-signal.ts`), which the new sky ends when it is on screen.
 */
export function ConstellationViewsMenu({
  tabs,
  activeId,
  canCreate,
  className,
}: {
  tabs: ConstellationTab[];
  activeId: string | null;
  canCreate: boolean;
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"list" | "compose">("list");
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ConstellationTab | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const active = tabs.find((t) => t.id === activeId) ?? null;
  const name = active?.name ?? "My network";

  function changeOpen(next: boolean, details?: { reason: string; event: Event }) {
    if (pending) return;
    // Escape inside the rename field cancels the rename, not the whole menu (see RenameField).
    if (details?.reason === "escape-key" && details.event.defaultPrevented) return;
    setOpen(next);
    if (!next) {
      setStep("list");
      setRenamingId(null);
    }
  }

  /**
   * Close the rename field and hand focus back to its row. The field unmounts with focus inside
   * it; flushed, so the row is in the DOM and focused before the popover's focus manager (a
   * microtask later) sees focus on <body> and parks it on the popup instead.
   */
  const endRename = (id: string, refocus: boolean) => {
    if (!refocus) return setRenamingId(null);
    flushSync(() => setRenamingId(null));
    list.current?.querySelector<HTMLElement>(`[data-view="${id}"]`)?.focus();
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const asked = prompt.trim();
    if (!asked || pending) return;
    setPending(true);
    setOpen(false);
    startGenerating(asked);
    try {
      const { id } = await createConstellation(asked);
      setPrompt("");
      setStep("list");
      awaitNewSky();
      router.push(`/graph?c=${id}`);
      // Without this the client cache can serve a list from before the new view existed.
      router.refresh();
    } catch (err) {
      stopGenerating();
      toast.error(friendlyError(err, "Couldn’t draw that constellation — try again?"));
      // Back to the words they wrote, so a retry is one keystroke.
      setStep("compose");
      setOpen(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Popover open={open} onOpenChange={changeOpen}>
        <PopoverTrigger
          ref={trigger}
          title={name}
          aria-label={`View: ${name}`}
          className={cn(
            CONTROL_SHELL,
            // Compact below `sm` so "My network" and Top | All fit beside the title at 375px;
            // min-w-0 lets a long view name truncate rather than push the row wider.
            "min-w-0 max-w-[8.5rem] shrink cursor-pointer gap-0.5 px-2.5 text-xs text-foreground outline-none transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 sm:gap-1 sm:px-3 sm:text-sm",
            className
          )}
        >
          <span className="truncate">{name}</span>
          <ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground sm:size-3.5" />
        </PopoverTrigger>
        <PopoverContent
          align="end"
          aria-label={step === "list" ? "Constellations" : "Describe a constellation"}
          className={cn("max-w-[calc(100vw-1.5rem)]", step === "list" ? "w-72 p-1.5" : "w-80")}
        >
          {step === "list" ? (
            <ul ref={list} className="space-y-0.5">
              <li className="flex">
                <Link
                  href="/graph"
                  data-view="all"
                  aria-current={active ? undefined : "page"}
                  onClick={() => changeOpen(false)}
                  className={cn(ROW, !active && "bg-primary/10 font-medium")}
                >
                  My network
                </Link>
              </li>
              {tabs.map((t) => (
                <li key={t.id} className="flex items-center gap-0.5">
                  {renamingId === t.id ? (
                    <RenameField
                      tab={t}
                      onDone={(refocus) => endRename(t.id, refocus)}
                      onSaved={() => {
                        endRename(t.id, true);
                        router.refresh();
                      }}
                    />
                  ) : (
                    <>
                      <Link
                        href={`/graph?c=${t.id}`}
                        data-view={t.id}
                        aria-current={t.id === active?.id ? "page" : undefined}
                        title={t.name}
                        onClick={() => changeOpen(false)}
                        className={cn(ROW, t.id === active?.id && "bg-primary/10 font-medium")}
                      >
                        <span className="truncate">{t.name}</span>
                        <span className="ml-auto text-xs tabular-nums text-muted-foreground">{t.memberCount}</span>
                      </Link>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          aria-label={`Options for ${t.name}`}
                          className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "shrink-0")}
                        >
                          <MoreHorizontal />
                        </DropdownMenuTrigger>
                        {/* finalFocus off: the rename field takes focus itself, and returning it to the trigger would blur (cancel) it. */}
                        <DropdownMenuContent align="end" className="w-36" finalFocus={false}>
                          <DropdownMenuItem onClick={() => setRenamingId(t.id)}>Rename</DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => {
                              changeOpen(false);
                              setDeleting(t);
                            }}
                          >
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  )}
                </li>
              ))}
              <li className="mt-1 flex border-t pt-1">
                <button type="button" onClick={() => setStep("compose")} className={cn(ROW, "text-primary")}>
                  <Plus aria-hidden className="size-3.5" />
                  New constellation
                </button>
              </li>
            </ul>
          ) : (
            <div className="space-y-2.5">
              <p className="font-medium text-sm">Describe a constellation</p>
              {canCreate ? (
                <form onSubmit={submit} className="space-y-2.5">
                  <Textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter sends, Shift+Enter is a new line; never mid-composition (IME). Safari
                      // fires compositionend BEFORE the confirming keydown, so isComposing is already
                      // false there; keyCode 229 is how that keydown still identifies itself.
                      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                        e.preventDefault();
                        e.currentTarget.form?.requestSubmit();
                      }
                    }}
                    rows={3}
                    maxLength={PROMPT_MAX}
                    placeholder="e.g. Founders I’ve met at events who work on climate"
                    aria-label="Describe a constellation"
                    aria-describedby="constellation-compose-help"
                    // readOnly, not disabled: a disabled field drops focus, which a failed create would then lose.
                    readOnly={pending}
                    autoFocus
                    className="min-h-[4.75rem] max-h-40 resize-none"
                  />
                  <p id="constellation-compose-help" className="text-xs text-muted-foreground">
                    Orbit picks the people. You can add or remove them after.
                  </p>
                  <div className="flex items-center justify-between gap-2">
                    <BackButton onClick={() => setStep("list")} />
                    <Button type="submit" size="sm" disabled={pending || !prompt.trim()} aria-busy={pending}>
                      {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                      Create
                    </Button>
                  </div>
                </form>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">{FREE_CAP_COPY}</p>
                  <div className="flex items-center justify-between gap-2">
                    <BackButton onClick={() => setStep("list")} />
                    <Link href="/pricing" className={buttonVariants({ size: "sm" })}>
                      See plans
                    </Link>
                  </div>
                </>
              )}
            </div>
          )}
        </PopoverContent>
      </Popover>
      {deleting && (
        <DeleteDialog
          tab={deleting}
          // The menu item that opened it is gone with the popover; land back on the menu.
          returnFocus={trigger}
          open
          onOpenChange={(next) => !next && setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            // Deleting another view leaves this one on screen; deleting this one goes home.
            if (deleting.id === active?.id) router.push("/graph");
            // The client cache can still hold a /graph payload listing this view; refresh takes
            // over the push and fetches the list fresh.
            router.refresh();
          }}
        />
      )}
    </>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      Back
    </button>
  );
}

function RenameField({
  tab,
  onDone,
  onSaved,
}: {
  tab: ConstellationTab;
  /** `refocus` is false when the field closed because focus already went elsewhere. */
  onDone: (refocus: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(tab.name);
  const [pending, setPending] = useState(false);

  async function save() {
    const next = name.trim();
    if (!next || next === tab.name) return onDone(true);
    setPending(true);
    try {
      if (!(await renameConstellation(tab.id, next))) {
        // Nothing renamed: the sky is gone (deleted in another tab) or not this person's.
        toast.error("Couldn’t rename that — try again?");
        return onDone(true);
      }
      onSaved();
    } catch (err) {
      setPending(false);
      toast.error(friendlyError(err, TOAST_COPY.saveFailed));
    }
  }

  return (
    <Input
      value={name}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void save();
        } else if (e.key === "Escape") {
          // Cancels the rename only: the popover around it hears Escape on `document`, where
          // stopping propagation cannot reach, so it is told by the default being prevented.
          e.preventDefault();
          onDone(true);
        }
      }}
      onBlur={() => !pending && onDone(false)}
      maxLength={NAME_MAX}
      aria-label="Constellation name"
      // readOnly, not disabled: a disabled field can drop focus, and a blur here means "cancel".
      readOnly={pending}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      className="h-8 flex-1 px-2"
    />
  );
}

function DeleteDialog({
  tab,
  returnFocus,
  open,
  onOpenChange,
  onDeleted,
}: {
  tab: ConstellationTab;
  returnFocus: RefObject<HTMLElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const [pending, setPending] = useState(false);

  async function confirm() {
    setPending(true);
    try {
      await deleteConstellation(tab.id);
      onDeleted();
    } catch (err) {
      toast.error(friendlyError(err, TOAST_COPY.deleteFailed));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent showCloseButton={false} finalFocus={returnFocus}>
        <DialogHeader>
          <DialogTitle>Delete “{tab.name}”?</DialogTitle>
          <DialogDescription>
            This removes the constellation only. The people in it stay in your network.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={pending} aria-busy={pending}>
            {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
