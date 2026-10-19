"use client";

import { useState, useTransition } from "react";
import { IntentLink } from "@/components/ui/intent-link";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, Copy, Undo2, X } from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageSection } from "@/components/layout/page-header";
import {
  dismissDuplicatePair,
  mergeDuplicatePair,
  undoMerge,
  type RecentMerge,
} from "@/actions/duplicates";
import type { DuplicateCandidate, DuplicatePair } from "@/lib/duplicate-review";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

function describe(c: DuplicateCandidate) {
  return [c.title, c.company].filter(Boolean).join(" · ");
}

/**
 * One side of a pair.
 *
 * `interactionCount` is shown because it is the number that decides which side to keep —
 * merging into the emptier record is the mistake people actually make, and the fold only
 * fills blanks, so the fuller row should almost always survive.
 */
function Side({
  contact,
  role,
  selected,
  onSelect,
}: {
  contact: DuplicateCandidate;
  role: "keep" | "merge";
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex-1 rounded-lg border p-3 text-left transition-colors",
        selected
          ? "border-primary bg-primary/5"
          : "border-border-subtle hover:border-border hover:bg-muted/40"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium">{contact.fullName}</span>
        {selected ? (
          <Badge variant="secondary" className="shrink-0">
            Keep
          </Badge>
        ) : null}
      </div>
      {describe(contact) ? (
        <p className="mt-0.5 truncate text-sm text-muted-foreground">{describe(contact)}</p>
      ) : null}
      {contact.email ? (
        <p className="truncate text-xs text-muted-foreground">{contact.email}</p>
      ) : null}
      <p className="mt-1 text-xs text-muted-foreground">
        {contact.interactionCount === 1
          ? "1 interaction"
          : `${contact.interactionCount} interactions`}
      </p>
      <span className="sr-only">
        {selected
          ? `${contact.fullName} will be kept`
          : `Keep ${contact.fullName} instead`}
        {role === "merge" ? " (currently the record being merged away)" : ""}
      </span>
    </button>
  );
}

/**
 * The model's read on a pair, in words. A hint only: the queue is ordered by it, but nothing
 * merges without a click, and the person's own judgement is the one that counts.
 */
function decisionHint(decision: DuplicatePair["decision"]): string | null {
  if (!decision) return null;
  const who = decision.engine === "jev" ? "decision model" : "your AI model";
  const p = decision.sameProbability;
  if (p >= 0.7) return `Likely the same person, says the ${who}`;
  if (p <= 0.3) return `Likely two different people, says the ${who}`;
  return `Hard to tell, says the ${who}`;
}

function PairCard({ pair }: { pair: DuplicatePair }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Which side survives. Defaults to the older contact, matching how every automatic merge
  // picks a winner, but the user can flip it — the fuller record is often the newer one.
  const [keepId, setKeepId] = useState(pair.keep.id);
  const [done, setDone] = useState<null | "merged" | "dismissed">(null);

  if (done) return null;

  const keep = keepId === pair.keep.id ? pair.keep : pair.merge;
  const drop = keepId === pair.keep.id ? pair.merge : pair.keep;

  const onMerge = () =>
    startTransition(async () => {
      try {
        await mergeDuplicatePair(keep.id, drop.id, pair.reason);
        setDone("merged");
        toast.success(`Merged into ${keep.fullName}`, {
          description: "The other record is hidden — you can undo this below",
        });
        router.refresh();
      } catch (err) {
        // The description used to carry `err.message`, which production turns into the
        // Server Components digest. See `friendlyError`.
        toast.error(friendlyError(err, TOAST_COPY.mergeFailed));
      }
    });

  const onDismiss = () =>
    startTransition(async () => {
      // By contact ids, not by suggestion id: a pair found by scanning for a shared name has
      // no stored row yet, and dismissing it is what creates one.
      // Guarded like its siblings: unhandled, a failure here threw inside the transition.
      try {
        await dismissDuplicatePair(pair.keep.id, pair.merge.id);
        setDone("dismissed");
        toast.success("Dismissed", { description: "This pair won’t be suggested again" });
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t dismiss that pair — try again?"));
      }
    });

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle as="h3" className="flex items-center gap-2">
          {pair.reason}
          {!pair.certain ? (
            <Badge variant="outline" className="font-normal">
              Not certain
            </Badge>
          ) : null}
        </CardTitle>
        {decisionHint(pair.decision) ? (
          <CardDescription>{decisionHint(pair.decision)}</CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
          <Side
            contact={pair.keep}
            role="keep"
            selected={keepId === pair.keep.id}
            onSelect={() => setKeepId(pair.keep.id)}
          />
          <div className="flex items-center justify-center px-1 text-muted-foreground">
            <ArrowRight className="size-4 rotate-90 sm:rotate-0" aria-hidden />
          </div>
          <Side
            contact={pair.merge}
            role="merge"
            selected={keepId === pair.merge.id}
            onSelect={() => setKeepId(pair.merge.id)}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onMerge} disabled={pending}>
            <Check className="size-4" aria-hidden />
            Merge into {keep.fullName}
          </Button>
          {!pair.certain ? (
            <Button size="sm" variant="ghost" onClick={onDismiss} disabled={pending}>
              <X className="size-4" aria-hidden />
              Not the same person
            </Button>
          ) : null}
          <IntentLink
            href={`/contacts/${drop.id}`}
            className="ml-auto text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            Review {drop.fullName}
          </IntentLink>
        </div>
      </CardContent>
    </Card>
  );
}

export function DuplicateReviewList({
  proposed,
  recentMerges,
}: {
  proposed: DuplicatePair[];
  recentMerges: RecentMerge[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const onUndo = (mergeId: string) =>
    startTransition(async () => {
      try {
        await undoMerge(mergeId);
        toast.success("Merge undone", { description: "The contact and its history are back" });
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.undoFailed));
      }
    });

  const nothingToDo = proposed.length === 0;

  return (
    <div className="space-y-8">
      {nothingToDo ? (
        <EmptyState
          icon={Copy}
          title="Nothing to review"
          description="Duplicates are merged automatically whenever Orbit can tell two records are the same person. Only genuinely ambiguous pairs land here."
        />
      ) : null}

      {proposed.length > 0 ? (
        <PageSection
          title="Possibly the same person"
          description="These share a name and nothing else, which two different people can do — so Orbit left them alone rather than guessing."
        >
          <div className="space-y-3">
            {proposed.map((pair) => (
              <PairCard key={`${pair.keep.id}:${pair.merge.id}`} pair={pair} />
            ))}
          </div>
        </PageSection>
      ) : null}

      {recentMerges.length > 0 ? (
        <PageSection
          title="Recently merged"
          description="Nothing is deleted by a merge. Undo restores the contact and everything that moved with it."
        >
          <ul className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-card">
            {recentMerges.map((merge) => (
              <li key={merge.id} className="flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    <span className="text-muted-foreground">{merge.loserName ?? "A contact"}</span>
                    <ArrowRight className="mx-1.5 inline size-3" aria-hidden />
                    <IntentLink
                      href={`/contacts/${merge.winnerId}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {merge.winnerName ?? "contact"}
                    </IntentLink>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {merge.reason ? `${merge.reason} · ` : ""}
                    {new Date(merge.mergedAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onUndo(merge.id)}
                  disabled={pending}
                >
                  <Undo2 className="size-4" aria-hidden />
                  Undo
                </Button>
              </li>
            ))}
          </ul>
        </PageSection>
      ) : null}
    </div>
  );
}
