"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, Undo2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  dismissDuplicatePair,
  mergeDuplicatePair,
  undoMerge,
  type RecentMerge,
} from "@/actions/duplicates";
import type { DuplicateCandidate, DuplicatePair } from "@/lib/duplicate-review";
import { cn } from "@/lib/utils";

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
          : "border-border/60 hover:border-border hover:bg-muted/40"
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
          description: "The other record is hidden. You can undo this below.",
        });
        router.refresh();
      } catch (err) {
        toast.error("Could not merge", {
          description: err instanceof Error ? err.message : "Please try again.",
        });
      }
    });

  const onDismiss = () =>
    startTransition(async () => {
      // By contact ids, not by suggestion id: a pair found by scanning for a shared name has
      // no stored row yet, and dismissing it is what creates one.
      await dismissDuplicatePair(pair.keep.id, pair.merge.id);
      setDone("dismissed");
      toast.success("Dismissed", { description: "This pair won't be suggested again." });
      router.refresh();
    });

  return (
    <Card className="group/card" data-size="sm">
      <CardHeader className="pb-2">
        <CardTitle as="h3" className="flex items-center gap-2 text-sm">
          {pair.reason}
          {!pair.certain ? (
            <Badge variant="outline" className="font-normal">
              Not certain
            </Badge>
          ) : null}
        </CardTitle>
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
            <ArrowRight className="h-4 w-4 rotate-90 sm:rotate-0" aria-hidden />
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
            <Check className="h-4 w-4" aria-hidden />
            Merge into {keep.fullName}
          </Button>
          {!pair.certain ? (
            <Button size="sm" variant="ghost" onClick={onDismiss} disabled={pending}>
              <X className="h-4 w-4" aria-hidden />
              Not the same person
            </Button>
          ) : null}
          <Link
            href={`/contacts/${drop.id}`}
            className="ml-auto text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            Review {drop.fullName}
          </Link>
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
        toast.success("Merge undone", { description: "The contact and its history are back." });
        router.refresh();
      } catch (err) {
        toast.error("Could not undo", {
          description: err instanceof Error ? err.message : "Please try again.",
        });
      }
    });

  const nothingToDo = proposed.length === 0;

  return (
    <div className="space-y-8">
      {nothingToDo ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="font-heading text-base">Nothing to review</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Duplicates are merged automatically whenever Orbit can tell two records are the
              same person. Only genuinely ambiguous pairs land here.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {proposed.length > 0 ? (
        <section className="space-y-3">
          <div>
            <h2 className="font-heading text-lg">Possibly the same person</h2>
            <p className="text-sm text-muted-foreground">
              These share a name and nothing else, which two different people can do — so
              Orbit left them alone rather than guessing.
            </p>
          </div>
          <div className="space-y-3">
            {proposed.map((pair) => (
              <PairCard key={`${pair.keep.id}:${pair.merge.id}`} pair={pair} />
            ))}
          </div>
        </section>
      ) : null}

      {recentMerges.length > 0 ? (
        <section className="space-y-3">
          <div>
            <h2 className="font-heading text-lg">Recently merged</h2>
            <p className="text-sm text-muted-foreground">
              Nothing is deleted by a merge. Undo restores the contact and everything that
              moved with it.
            </p>
          </div>
          <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
            {recentMerges.map((merge) => (
              <li key={merge.id} className="flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    <span className="text-muted-foreground">{merge.loserName ?? "A contact"}</span>
                    <ArrowRight className="mx-1.5 inline h-3 w-3" aria-hidden />
                    <Link
                      href={`/contacts/${merge.winnerId}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {merge.winnerName ?? "contact"}
                    </Link>
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
                  <Undo2 className="h-4 w-4" aria-hidden />
                  Undo
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
