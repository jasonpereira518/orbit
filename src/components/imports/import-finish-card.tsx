"use client";

import Link from "next/link";
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
import {
  finishCopy,
  undoDismissLabel,
  type FinishSummary,
} from "@/lib/imports/import-finish";
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
  importIds,
  label = IMPORT_COPY.undoAction,
  variant = "ghost",
  size = "sm",
  className,
  onUndone,
}: {
  /**
   * Every import this undo covers. One in the history sheet; a whole run's worth on the done
   * card, because a dropped LinkedIn archive is two imports and one card, and an Undo that
   * took back only half of what the sentence above it counted would be its own kind of lie.
   */
  importIds: string[];
  label?: string;
  variant?: "ghost" | "outline" | "link";
  size?: "xs" | "sm" | "default";
  className?: string;
  /**
   * Called once the removal has finished. The page owns what to re-read afterwards — this
   * component deliberately does not reach for `useRouter`, so it and the card around it stay
   * renderable outside an app router (which is how `smoke-import-finish.ts` holds the "no
   * swarm over bad news" rule).
   */
  onUndone?: () => void;
}) {
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
      const parts: UndoPreview[] = [];
      for (const id of importIds) {
        const next = await previewImportUndo(id);
        if (next) parts.push(next);
      }
      if (!parts.length) {
        setOpen(false);
        toast.error(IMPORT_COPY.undoGone);
        return;
      }
      setPreview(foldPreviews(parts));
      setPhase("ready");
    } catch (err) {
      setOpen(false);
      toast.error(friendlyError(err, IMPORT_COPY.undoFailed));
    }
  }, [importIds]);

  const confirm = useCallback(async () => {
    setPhase("removing");
    let removed = 0;
    try {
      let allFinished = true;
      for (const id of importIds) {
        let finished = false;
        for (let round = 0; round < MAX_UNDO_ROUNDS && !finished; round++) {
          const result = await undoImport(id);
          removed += result.removed;
          setRemovedSoFar(removed);
          finished = result.done;
        }
        if (!finished) allFinished = false;
      }
      setOpen(false);
      if (allFinished) toast.success(`Removed ${people(removed)}`);
      else toast.message(IMPORT_COPY.undoStillGoing);
      onUndone?.();
    } catch (err) {
      setPhase("ready");
      toast.error(friendlyError(err, IMPORT_COPY.undoFailed));
    }
  }, [importIds, onUndone]);

  /**
   * Closing while the first round is still in flight would leave work running with nothing
   * reporting it, so the dialog holds until something has come back. After that it lets go:
   * the operation is idempotent and resumable — which is exactly what `undoStillGoing` tells
   * the person — so trapping them behind a progress line buys nothing.
   */
  const dismissable = phase !== "removing" || removedSoFar > 0;

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
              {undoDismissLabel(phase, Boolean(preview && canRemove(preview)))}
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

/**
 * A run's previews, read as one.
 *
 * The confirmation has to state what the button above it promised, and on a multi-file drop
 * that promise spans every import the run wrote. The folds are all the cautious direction:
 * `withinWindow` needs every part to still be inside it, `alreadyUndone` means every part
 * already went, and `exact` is false if any single part cannot vouch for itself — a caveat
 * that applies to some of the people is a caveat the person has to see.
 */
function foldPreviews(parts: UndoPreview[]): UndoPreview {
  const [first] = parts;
  if (parts.length === 1) return first;
  return {
    importId: first.importId,
    withinWindow: parts.every((p) => p.withinWindow),
    alreadyUndone: parts.every((p) => p.alreadyUndone),
    exact: parts.every((p) => p.exact),
    // Kept first across the whole run, for the same reason `previewUndo` orders them that
    // way: those are the names the confirmation actually has to explain.
    candidates: [
      ...parts.flatMap((p) => p.candidates.filter((c) => !c.removable)),
      ...parts.flatMap((p) => p.candidates.filter((c) => c.removable)),
    ],
    removable: parts.reduce((n, p) => n + p.removable, 0),
    keeping: parts.reduce((n, p) => n + p.keeping, 0),
  };
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
            reason underneath said "you’ve set a reminder" — and "notes, tags or reminders"
            still outran three of the six reasons (merged, edited, logged). "Touched since"
            is the one phrase that covers all six, and the per-person lines below say which.
          */}
          {preview.keeping === 1
            ? "1 of them has been touched since, so they’ll stay"
            : preview.keeping > 1
              ? `${preview.keeping} of them have been touched since, so they’ll stay`
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

      {/*
        What undo leaves behind. Said here, beside the Cancel button, because the field
        changes this import made to people it matched are not stored anywhere and cannot be
        reversed — the person deserves to know that before they choose, not after.
      */}
      <p className="text-xs text-muted-foreground">
        {IMPORT_COPY.undoKeepsMatched}
      </p>

      {!preview.exact ? (
        <p className="text-xs text-muted-foreground">
          {IMPORT_COPY.undoInexact}
        </p>
      ) : null}

      {/*
        Always rendered, empty until removal starts: the same reason as the finish sentence's
        region in `ImportQueueCard` — a status node that mounts with its text already inside is
        the case screen readers skip. Visually hidden while there is nothing to say, so it
        takes no room in the dialog.
      */}
      <p
        role="status"
        className={cn(
          "text-xs text-muted-foreground",
          phase !== "removing" && "sr-only",
        )}
      >
        {phase === "removing"
          ? removedSoFar > 0
            ? `${people(removedSoFar)} out so far`
            : IMPORT_COPY.undoRemoving
          : null}
      </p>
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
  onUndone,
  className,
}: {
  summary: FinishSummary;
  avatars: FinishFace[];
  onDismiss?: () => void;
  /** Opens the history detail sheet, for the finish that has no people to link to. */
  onShowDetail?: () => void;
  /** Called after this card's Undo has finished, so the page can re-read what changed. */
  onUndone?: () => void;
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

      {/*
        No swarm over bad news (spec §1). When a step didn't finish the card leads with that
        instead of celebrating, and a field of people settling into orbit underneath
        "Your LinkedIn messages didn't finish" is the card celebrating anyway.
      */}
      {summary.unfinished ? null : (
        <ImportFinishScene
          people={summary.added || summary.existing}
          faces={faces}
        />
      )}

      <div className="space-y-1 text-center">
        {/*
          Not a live region. A status node that mounts with its text already inside is the
          one case screen readers do not reliably announce, so the announcement lives in
          `ImportQueueCard`: an empty region that exists before the run ends and has this
          sentence set into it when the phase becomes done. The card a person comes back to
          after a refresh is read, not announced.
        */}
        <p className="font-[family-name:var(--font-display)] text-xl text-ink">
          {copy.headline}
        </p>
        {copy.detail ? (
          <p className="text-sm text-muted-foreground">{copy.detail}</p>
        ) : null}
        {copy.notices.map((notice) =>
          notice.href ? (
            <p key={notice.text} className="text-sm">
              <Link
                href={notice.href}
                className="text-primary underline underline-offset-2"
              >
                {notice.text}
              </Link>
            </p>
          ) : (
            <p key={notice.text} className="text-sm text-destructive">
              {notice.text}
            </p>
          ),
        )}
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
        {/*
          Only when there is one. `finishCopy` puts "From Connections.csv and address-book.csv"
          in the detail line the moment a run has several sources — which never happened while
          a card described a single import, and printed the same sentence twice the moment one
          could describe a whole drop.
        */}
        {summary.sources.length === 1 ? (
          <span className="truncate">From {summary.sources[0]}</span>
        ) : null}
        <ImportUndoButton
          importIds={summary.importIds}
          label="Undo"
          size="xs"
          variant="link"
          className="text-muted-foreground hover:text-foreground"
          onUndone={onUndone}
        />
      </p>
    </section>
  );
}
