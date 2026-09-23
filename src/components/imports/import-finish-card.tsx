"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { Undo2, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ImportFinishScene } from "@/components/imports/import-finish-scene";
import { previewImportUndo, undoImport } from "@/actions/imports";
import { finishCopy, type FinishSummary } from "@/lib/imports/import-finish";
import { IMPORT_COPY } from "@/lib/imports/import-copy";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * The end of an import, and the way back out of one.
 *
 * `/imports` used to stop at a list of rows with a tick beside each: true, and about the
 * files rather than about the people. This card is the other half of that sentence — the
 * swarm of people who just arrived, what happened in one line, one thing to do next, and an
 * undo for the case where the answer is "not these".
 *
 * The words are `finishCopy`'s, not this file's: the card, the history chips and the People
 * list all describe the same import and have disagreed before, so the arithmetic lives in one
 * pure module and this renders what it returns.
 */

export type FinishFace = {
  contactId: string;
  name: string;
  photo: string | null;
};

/**
 * The preview's shape, taken from the action rather than imported from `import-undo.ts`.
 * That module reaches `@/db`, and a client component importing it — even for a type, one
 * careless edit later — is the `node:fs` chunk error that makes the build unexplainable.
 */
type UndoPreview = NonNullable<Awaited<ReturnType<typeof previewImportUndo>>>;
type UndoCandidate = UndoPreview["candidates"][number];

const KEPT_REASON: Record<NonNullable<UndoCandidate["reason"]>, string> = {
  tagged: IMPORT_COPY.undoKeptTagged,
  noted: IMPORT_COPY.undoKeptNoted,
  reminded: IMPORT_COPY.undoKeptReminded,
  interacted: IMPORT_COPY.undoKeptInteracted,
  merged: IMPORT_COPY.undoKeptMerged,
  edited: IMPORT_COPY.undoKeptEdited,
};

/** Kept people named in the confirmation before the rest are named as a number. */
const NAMED_EXCEPTIONS = 6;

/**
 * How many times the UI will re-invoke `undoImport` before handing back to the person.
 *
 * `undoImport` already loops internally under its own 120s ceiling, so one call finishes all
 * but the largest imports. This is the second guard, and it is deliberate: a call that comes
 * back `done: false` has NOT finished, and reporting success there would tell someone their
 * people are gone while they are still on screen. The cap exists so a pathological case — a
 * delete that keeps being refused — ends in a sentence rather than a loop.
 */
const MAX_UNDO_ROUNDS = 8;

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

/**
 * The undo, from the button through the confirmation to the last person removed.
 *
 * Shared by the done card and the history detail sheet so there is one flow, one set of
 * words, and one place where the counts are checked before anything is deleted. Nothing is
 * removed until the person has read the two numbers and the names behind the second one.
 */
export function ImportUndoButton({
  importId,
  label = IMPORT_COPY.undoAction,
  variant = "ghost",
  size = "sm",
  className,
  onUndone,
}: {
  importId: string;
  label?: string;
  variant?: "ghost" | "outline" | "link";
  size?: "xs" | "sm" | "default";
  className?: string;
  onUndone?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<UndoPreview | null>(null);
  const [phase, setPhase] = useState<"checking" | "ready" | "removing">(
    "checking",
  );
  const [removedSoFar, setRemovedSoFar] = useState(0);

  const start = useCallback(async () => {
    setPreview(null);
    setRemovedSoFar(0);
    setPhase("checking");
    setOpen(true);
    try {
      const next = await previewImportUndo(importId);
      if (!next) {
        setOpen(false);
        toast.error(IMPORT_COPY.undoGone);
        return;
      }
      setPreview(next);
      setPhase("ready");
    } catch (err) {
      setOpen(false);
      toast.error(friendlyError(err, IMPORT_COPY.undoFailed));
    }
  }, [importId]);

  const confirm = useCallback(async () => {
    setPhase("removing");
    let removed = 0;
    try {
      let finished = false;
      for (let round = 0; round < MAX_UNDO_ROUNDS && !finished; round++) {
        const result = await undoImport(importId);
        removed += result.removed;
        setRemovedSoFar(removed);
        finished = result.done;
      }
      setOpen(false);
      if (finished) toast.success(`Removed ${people(removed)}`);
      else toast.message(IMPORT_COPY.undoStillGoing);
      onUndone?.();
      router.refresh();
    } catch (err) {
      setPhase("ready");
      toast.error(friendlyError(err, IMPORT_COPY.undoFailed));
    }
  }, [importId, onUndone, router]);

  // Closing mid-removal would leave the work running with nothing reporting it, so the
  // dialog stays put until the loop is done with it.
  const dismissable = phase !== "removing";

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        onClick={() => void start()}
      >
        <Undo2 />
        {label}
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !dismissable) return;
          setOpen(next);
        }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <UndoDialogBody
            preview={preview}
            phase={phase}
            removedSoFar={removedSoFar}
          />
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              disabled={!dismissable}
              onClick={() => setOpen(false)}
            >
              {preview && canRemove(preview)
                ? IMPORT_COPY.undoCancel
                : "Close"}
            </Button>
            {preview && canRemove(preview) ? (
              <Button
                variant="destructive"
                disabled={phase !== "ready"}
                onClick={() => void confirm()}
              >
                {phase === "removing"
                  ? IMPORT_COPY.undoRemoving
                  : IMPORT_COPY.undoConfirm}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Whether there is anything this undo would actually do. */
function canRemove(preview: UndoPreview): boolean {
  return (
    preview.withinWindow && !preview.alreadyUndone && preview.removable > 0
  );
}

function UndoDialogBody({
  preview,
  phase,
  removedSoFar,
}: {
  preview: UndoPreview | null;
  phase: "checking" | "ready" | "removing";
  removedSoFar: number;
}) {
  if (!preview || phase === "checking") {
    return (
      <DialogHeader>
        <DialogTitle>{IMPORT_COPY.undoAction}</DialogTitle>
        <DialogDescription>{IMPORT_COPY.undoChecking}</DialogDescription>
      </DialogHeader>
    );
  }

  if (preview.alreadyUndone) {
    return (
      <DialogHeader>
        <DialogTitle>{IMPORT_COPY.undoAction}</DialogTitle>
        <DialogDescription>{IMPORT_COPY.undoAlreadyDone}</DialogDescription>
      </DialogHeader>
    );
  }

  if (!preview.withinWindow) {
    return (
      <DialogHeader>
        <DialogTitle>{IMPORT_COPY.undoAction}</DialogTitle>
        <DialogDescription>{IMPORT_COPY.undoWindowClosed}</DialogDescription>
      </DialogHeader>
    );
  }

  if (preview.removable === 0) {
    return (
      <DialogHeader>
        <DialogTitle>{IMPORT_COPY.undoAction}</DialogTitle>
        <DialogDescription>{IMPORT_COPY.undoNobodyLeft}</DialogDescription>
      </DialogHeader>
    );
  }

  const kept = preview.candidates.filter((c) => !c.removable);
  const named = kept.slice(0, NAMED_EXCEPTIONS);
  const unnamed = preview.keeping - named.length;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Remove {people(preview.removable)}?</DialogTitle>
        <DialogDescription>
          {/*
            "notes or tags" was the original wording and it read as a lie the moment the
            reason underneath said "you’ve set a reminder". The sentence names the whole set
            it is actually describing, and agrees with itself when there is only one.
          */}
          {preview.keeping === 1
            ? "1 of them has a note, a tag or a reminder now, so they’ll stay"
            : preview.keeping > 1
              ? `${preview.keeping} of them have notes, tags or reminders now, so they’ll stay`
              : "Everyone this import brought in goes back out"}
        </DialogDescription>
      </DialogHeader>

      {named.length ? (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {named.map((c) => (
            <li key={c.contactId} className="truncate">
              <span className="font-medium text-foreground">{c.name}</span>
              {c.reason ? ` — ${KEPT_REASON[c.reason]}` : null}
            </li>
          ))}
          {unnamed > 0 ? <li>and {people(unnamed)} more like these</li> : null}
        </ul>
      ) : null}

      {!preview.exact ? (
        <p className="text-xs text-muted-foreground">
          {IMPORT_COPY.undoInexact}
        </p>
      ) : null}

      {phase === "removing" ? (
        <p role="status" className="text-xs text-muted-foreground">
          {removedSoFar > 0
            ? `${people(removedSoFar)} out so far`
            : IMPORT_COPY.undoRemoving}
        </p>
      ) : null}
    </>
  );
}

/**
 * The done card itself.
 *
 * `faces` is memoised on the ids rather than passed straight through: the scene's effect
 * depends on the array by reference, so a parent that rebuilds it on every unrelated render
 * restarts the whole arrival animation underneath someone who is reading the sentence.
 */
export function ImportFinishCard({
  summary,
  avatars,
  onDismiss,
  onShowDetail,
  className,
}: {
  summary: FinishSummary;
  avatars: FinishFace[];
  onDismiss?: () => void;
  /** Opens the history detail sheet, for the finish that has no people to link to. */
  onShowDetail?: () => void;
  className?: string;
}) {
  const copy = finishCopy(summary);
  const faceKey = avatars.map((a) => a.contactId).join(",");
  const faces = useMemo(
    () => avatars,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- by identity, not by reference: see the note above
    [faceKey],
  );

  return (
    <section
      className={cn(
        "relative space-y-4 rounded-2xl border border-border/70 bg-card p-6",
        className,
      )}
    >
      {onDismiss ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute top-3 right-3 z-10"
          onClick={onDismiss}
        >
          <X className="size-4" />
          <span className="sr-only">Dismiss</span>
        </Button>
      ) : null}

      <ImportFinishScene
        people={summary.added || summary.existing}
        faces={faces}
      />

      <div className="space-y-1 text-center">
        {/*
          Announced once, when it appears. `role="status"` rather than an aria-live region
          built by hand: this node mounts with its text already in it, which is exactly the
          case a status region is for.
        */}
        <p
          role="status"
          className="font-[family-name:var(--font-display)] text-xl text-ink"
        >
          {copy.headline}
        </p>
        {copy.detail ? (
          <p className="text-sm text-muted-foreground">{copy.detail}</p>
        ) : null}
      </div>

      <div className="flex justify-center">
        {"href" in copy.action ? (
          // A link that looks like a button, the way the rest of the app writes one. Base UI's
          // `Button` renders a real <button> and warns when something else is put in its place.
          <Link href={copy.action.href} className={cn(buttonVariants())}>
            {copy.action.label}
          </Link>
        ) : (
          <Button type="button" variant="outline" onClick={onShowDetail}>
            {copy.action.label}
          </Button>
        )}
      </div>

      <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="truncate">From {summary.sources.join(" and ")}</span>
        <ImportUndoButton
          importId={summary.importId}
          label="Undo"
          size="xs"
          variant="link"
          className="text-muted-foreground hover:text-foreground"
        />
      </p>
    </section>
  );
}
