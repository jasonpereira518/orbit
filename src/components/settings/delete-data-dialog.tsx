"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";
import { TOAST_COPY } from "@/lib/toast-copy";
import { friendlyError } from "@/lib/errors";
import { cn } from "@/lib/utils";
import {
  DATA_CATEGORY_IDS,
  DATA_CATEGORY_META,
  expandCategories,
  lockedByImplication,
  type DataCategory,
} from "@/lib/data-categories";
import { deleteAllData, getDeletableDataFootprint } from "@/actions/settings";
import { cancelImportJob } from "@/lib/import-job-runner";

const CONFIRMATION = "delete";

/**
 * Picks which categories of the signed-in user's own data to delete, then deletes them.
 *
 * Two rules make the list honest rather than decorative:
 *   - Ticking a category the database cascades from (today: contacts) ticks and LOCKS what
 *     it takes with it, so nobody can leave "Interactions and notes" unticked and believe
 *     their notes survive deleting every contact those notes hang off.
 *   - Counts come from the server on open, so the choice is made against what is actually
 *     there rather than against a guess. A category with nothing in it is still offered —
 *     greying it out would read as "this is protected".
 *
 * Everything here is permanent and there is no export step in between, which is why the
 * typed confirmation is unconditional rather than reserved for the big categories.
 */
export function DeleteDataDialog({ trigger }: { trigger: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // What the user themselves ticked. The boxes actually rendered as checked are this
  // expanded through `implies` — keeping the two apart is what lets unticking "Contacts"
  // give "Interactions and notes" back rather than stranding it on.
  const [picked, setPicked] = useState<Set<DataCategory>>(
    () => new Set(DATA_CATEGORY_IDS)
  );
  const [typed, setTyped] = useState("");
  const [footprint, setFootprint] = useState<Record<
    DataCategory,
    number
  > | null>(null);
  // Set when a delete stopped part-way; the dialog stays open to say what happened.
  const [partial, setPartial] = useState<{
    deleted: DataCategory[];
    pending: DataCategory[];
  } | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!open) return;
    let live = true;
    getDeletableDataFootprint()
      .then((counts) => {
        if (live) setFootprint(counts);
      })
      // The counts are an aid, not the contract — the dialog still works without them.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open]);

  const effective = expandCategories([...picked]);
  const locked = lockedByImplication([...picked]);
  const confirmed = typed.trim().toLowerCase() === CONFIRMATION;
  const ready = effective.size > 0 && confirmed && !pending;

  const reset = () => {
    setPicked(new Set(DATA_CATEGORY_IDS));
    setTyped("");
    setPartial(null);
  };

  const toggle = (id: DataCategory) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = () => {
    if (!ready) return;
    const chosen = [...picked];
    start(async () => {
      try {
        // Stop any in-flight background work first: an import that keeps writing rows
        // through a delete would leave some of them behind. Import jobs stop after the
        // current chunk.
        cancelImportJob();
        window.dispatchEvent(new Event("orbit:stop-operations"));
        // Cross-tab best-effort: graph listeners can react via storage events.
        localStorage.setItem("orbit:stop-operations", String(Date.now()));

        const { deleted, pending: stillPending } = await deleteAllData(chosen);
        if (stillPending.length > 0) {
          setPartial({ deleted, pending: stillPending });
          setTyped("");
          toast.warning(
            `Deleted ${deleted.length} of ${deleted.length + stillPending.length} categories — Orbit will finish the rest on its own`
          );
          router.refresh();
          return;
        }
        setOpen(false);
        reset();
        toast.success(
          deleted.length === DATA_CATEGORY_IDS.length
            ? "All data deleted"
            : `Deleted ${deleted.length} ${deleted.length === 1 ? "category" : "categories"}`
        );
        router.refresh();
      } catch (e) {
        toast.error(friendlyError(e, TOAST_COPY.deleteFailed));
      }
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <span onClick={() => setOpen(true)}>{trigger}</span>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-destructive">
            Delete your Orbit data
          </DialogTitle>
          <DialogDescription>
            Choose what to remove. This is permanent — export first if you want a
            copy. Your account, plan and AI provider keys are kept.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {effective.size} of {DATA_CATEGORY_IDS.length} selected
          </span>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={pending}
              onClick={() => setPicked(new Set(DATA_CATEGORY_IDS))}
            >
              Select all
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={pending}
              onClick={() => setPicked(new Set())}
            >
              Select none
            </Button>
          </div>
        </div>

        <ul className="-mx-1 max-h-[45vh] space-y-1 overflow-y-auto px-1">
          {DATA_CATEGORY_META.map((category) => {
            const isLocked = locked.has(category.id);
            const checked = effective.has(category.id);
            const count = footprint?.[category.id];
            return (
              <li key={category.id}>
                <label
                  className={cn(
                    "flex cursor-pointer gap-3 rounded-lg p-2 transition-colors hover:bg-muted/60",
                    isLocked && "cursor-default opacity-70"
                  )}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggle(category.id)}
                    disabled={isLocked || pending}
                    // Base UI renders a button, which a wrapping `<label>` does not name —
                    // without this every box reads out as an unlabelled checkbox.
                    aria-label={category.label}
                    className="mt-0.5"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-medium text-ink">
                        {category.label}
                      </span>
                      {count !== undefined && count > 0 && (
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {count.toLocaleString()}{" "}
                          {count === 1 ? "record" : "records"}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                      {category.description}
                    </span>
                    {isLocked && (
                      <span className="mt-1 block text-xs leading-snug font-medium text-foreground/70">
                        Included — deleting contacts removes this too.
                      </span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>

        {partial && (
          <div
            role="status"
            className="rounded-lg border border-border bg-muted/40 p-3 text-xs leading-snug"
          >
            <p className="font-medium text-foreground">Part of this is still being deleted</p>
            <p className="mt-1 text-muted-foreground">
              Done: {labelsFor(partial.deleted)}
            </p>
            <p className="mt-1 text-muted-foreground">
              Still to go: {labelsFor(partial.pending)}. Orbit retries these on its own within a
              day — there’s nothing more you need to do
            </p>
          </div>
        )}

        <label className="block space-y-1.5">
          <span className="text-xs font-medium">
            Type {CONFIRMATION} to confirm
          </span>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={CONFIRMATION}
            className="h-8 text-sm"
            autoComplete="off"
          />
        </label>

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={submit}
            disabled={!ready}
          >
            {pending
              ? "Deleting…"
              : effective.size === DATA_CATEGORY_IDS.length
                ? "Delete everything"
                : `Delete ${effective.size} ${effective.size === 1 ? "category" : "categories"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function labelsFor(ids: readonly DataCategory[]): string {
  if (ids.length === 0) return "nothing yet";
  return DATA_CATEGORY_META.filter((c) => ids.includes(c.id))
    .map((c) => c.label)
    .join(", ");
}
