"use client";

import { useEffect, useState, useTransition } from "react";
import { IntentLink } from "@/components/ui/intent-link";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, ExternalLink, Minus, Undo2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { RelativeTime } from "@/components/ui/relative-time";
import {
  dismissDuplicatePair,
  mergeDuplicatePair,
  undoDismissDuplicatePair,
  undoMerge,
  type RecentDismissal,
  type RecentMerge,
} from "@/actions/duplicates";
import type { DuplicateCandidate, DuplicatePair } from "@/lib/duplicate-review";
import { interactionTypeLabel } from "@/lib/interaction-types";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

function describe(c: DuplicateCandidate) {
  return [c.title, c.company].filter(Boolean).join(" · ");
}

/** Below this, the model learned from past decisions thinks the pair is two different people. */
const PROBABLY_DIFFERENT_AT = 0.2;

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-xs">
      <dt className="w-16 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
    </div>
  );
}

/**
 * One side of a pair: enough to tell whether this is the person you know.
 *
 * Activity is shown because it decides which side to keep (merging into the emptier record is
 * the mistake people actually make, and the fold only fills blanks), and the latest touches,
 * tags and shared events are what tell you whether two same-named records are one human.
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
  const types = Object.entries(contact.interactionsByType).sort((a, b) => b[1] - a[1]);
  const otherEmails = contact.emails.filter((e) => e !== contact.email?.toLowerCase());
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-2 rounded-lg border p-3 text-left transition-colors",
        selected ? "border-primary bg-primary/5" : "border-border/60"
      )}
    >
      <div className="flex items-start gap-2.5">
        <ContactAvatar
          contactId={contact.id}
          fullName={contact.fullName}
          profileImageUrl={contact.profileImageUrl}
          size="lg"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <IntentLink
              href={`/contacts/${contact.id}`}
              className="truncate font-medium underline-offset-4 hover:underline"
            >
              {contact.fullName}
            </IntentLink>
            {selected ? (
              <Badge variant="secondary" className="shrink-0">
                Keep
              </Badge>
            ) : null}
          </div>
          {describe(contact) ? (
            <p className="truncate text-sm text-muted-foreground">{describe(contact)}</p>
          ) : (
            <p className="text-sm text-muted-foreground/70">No title or company</p>
          )}
        </div>
      </div>

      <dl className="space-y-1">
        {contact.email || otherEmails.length ? (
          <Detail label="Email">
            {[contact.email, ...otherEmails].filter(Boolean).join(", ")}
          </Detail>
        ) : null}
        {contact.phone || contact.phones.length ? (
          <Detail label="Phone">
            {[...new Set([contact.phone, ...contact.phones].filter(Boolean))].join(", ")}
          </Detail>
        ) : null}
        {contact.location ? <Detail label="Location">{contact.location}</Detail> : null}
        {contact.school ? <Detail label="School">{contact.school}</Detail> : null}
        {contact.linkedinUrl ? (
          <Detail label="LinkedIn">
            <a
              href={contact.linkedinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
            >
              Profile <ExternalLink className="h-3 w-3" aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </Detail>
        ) : null}
        {contact.createdAt ? (
          <Detail label="Added">
            <RelativeTime date={contact.createdAt} />
          </Detail>
        ) : null}
      </dl>

      <div className="space-y-1 border-t border-border/50 pt-2 text-xs">
        <p className="font-medium">
          {contact.interactionCount === 1
            ? "1 interaction"
            : `${contact.interactionCount} interactions`}
          {contact.lastInteractionAt ? (
            <span className="font-normal text-muted-foreground">
              {" "}
              · last <RelativeTime date={contact.lastInteractionAt} />
            </span>
          ) : null}
        </p>
        {types.length ? (
          <p className="text-muted-foreground">
            {types.slice(0, 3).map(([type, n]) => `${n} ${interactionTypeLabel(type).toLowerCase()}`).join(" · ")}
          </p>
        ) : null}
        {contact.recent[0]?.summary ? (
          <p className="line-clamp-1 text-muted-foreground">{contact.recent[0].summary}</p>
        ) : null}
        {contact.tags.length ? (
          <p className="truncate text-muted-foreground">{contact.tags.slice(0, 3).join(", ")}</p>
        ) : null}
      </div>

      <Button
        type="button"
        size="sm"
        variant={selected ? "secondary" : "outline"}
        onClick={onSelect}
        aria-pressed={selected}
        className="mt-auto"
      >
        {selected ? "Keeping" : "Keep this one"}
        <span className="sr-only">
          {` (${contact.fullName})`}
          {role === "merge" ? " currently the record being merged away" : ""}
        </span>
      </Button>
    </div>
  );
}

/** What matches and what differs between the two, so the call doesn't mean reading two columns. */
function SignalStrip({ notes }: { notes: NonNullable<DuplicatePair["notes"]> }) {
  if (!notes.length) {
    return (
      <p className="text-xs text-muted-foreground">Only the name matches.</p>
    );
  }
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="How these two compare">
      {notes.map((n) => (
        <li key={n.text}>
          <Badge
            variant="outline"
            className={cn(
              "gap-1 font-normal",
              n.kind === "match"
                ? "border-primary/40 text-foreground"
                : "border-border text-muted-foreground"
            )}
          >
            {n.kind === "match" ? (
              <Check className="h-3 w-3 text-primary" aria-hidden />
            ) : (
              <Minus className="h-3 w-3" aria-hidden />
            )}
            {n.text}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

/**
 * The model's read on a pair, in words. A hint only: the queue is ordered by it, but nothing
 * merges without a click, and the person's own judgement is the one that counts.
 */
function decisionHint(pair: DuplicatePair): string | null {
  if (pair.learned) {
    const p = pair.learned.probability;
    if (p >= 0.7) return "Similar pairs were usually merged";
    if (p <= PROBABLY_DIFFERENT_AT + 0.1) return "Similar pairs were usually kept apart";
  }
  const decision = pair.decision;
  if (!decision) return null;
  const p = decision.sameProbability;
  if (p >= 0.7) return "Likely the same person";
  if (p <= 0.3) return "Likely different people";
  return "Hard to tell";
}

function PairCard({
  pair,
  onResolved,
  onSkip,
}: {
  pair: DuplicatePair;
  /** Set on the queue's card: advances at once, and turns on the keyboard shortcuts. */
  onResolved?: (revert?: boolean) => void;
  onSkip?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Which side survives. Defaults to the older contact, matching how every automatic merge
  // picks a winner, but the user can flip it — the fuller record is often the newer one.
  const [keepId, setKeepId] = useState(pair.keep.id);
  const [done, setDone] = useState<null | "merged" | "dismissed">(null);
  const shortcuts = !!onResolved;

  const keep = keepId === pair.keep.id ? pair.keep : pair.merge;
  const drop = keepId === pair.keep.id ? pair.merge : pair.keep;
  // The numbers the page showed, handed back so the stored example matches what was decided on.
  const shown = {
    engineScore: pair.confidence,
    modelProbability: pair.decision?.sameProbability ?? pair.learned?.probability ?? null,
  };

  // Both actions move on BEFORE the server answers, so working down a list never waits on a
  // round trip; a failure puts the pair back and says so.
  const onMerge = () => {
    if (done) return;
    setDone("merged");
    onResolved?.();
    startTransition(async () => {
      try {
        await mergeDuplicatePair(keep.id, drop.id, pair.reason, shown);
        toast.success(`Merged into ${keep.fullName}`);
        router.refresh();
      } catch (err) {
        // The description used to carry `err.message`, which production turns into the
        // Server Components digest. See `friendlyError`.
        setDone(null);
        onResolved?.(true);
        toast.error(friendlyError(err, TOAST_COPY.mergeFailed));
      }
    });
  };

  const onDismiss = () => {
    if (done) return;
    setDone("dismissed");
    onResolved?.();
    startTransition(async () => {
      // By contact ids, not by suggestion id: a pair found by scanning for a shared name has
      // no stored row yet, and dismissing it is what creates one.
      try {
        await dismissDuplicatePair(pair.keep.id, pair.merge.id, shown);
        toast.success("Marked as different people");
        router.refresh();
      } catch (err) {
        setDone(null);
        onResolved?.(true);
        toast.error(friendlyError(err, "Couldn’t dismiss that pair — try again?"));
      }
    });
  };

  // M merge · D different people · S skip · K swap which one is kept. Only the queue's card
  // listens, and never while typing in a field.
  useEffect(() => {
    if (!shortcuts) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const k = e.key.toLowerCase();
      if (k === "m") onMerge();
      else if (k === "d") onDismiss();
      else if (k === "s") onSkip?.();
      else if (k === "k") setKeepId((id) => (id === pair.keep.id ? pair.merge.id : pair.keep.id));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (done) return null;

  const hint = decisionHint(pair);

  return (
    <Card className="group/card" data-size="sm">
      <CardHeader className="pb-2">
        <CardTitle as="h3" className="flex items-center gap-2 text-sm">
          {pair.reason}
        </CardTitle>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardHeader>
      <CardContent className="space-y-3">
        {pair.notes ? <SignalStrip notes={pair.notes} /> : null}
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
            Merge
            {shortcuts ? <kbd className="ml-1 rounded border border-current/30 px-1 text-[10px]">M</kbd> : null}
          </Button>
          <Button size="sm" variant="outline" onClick={onDismiss} disabled={pending}>
            <X className="h-4 w-4" aria-hidden />
            Different people
            {shortcuts ? <kbd className="ml-1 rounded border px-1 text-[10px]">D</kbd> : null}
          </Button>
          {onSkip ? (
            <Button size="sm" variant="ghost" onClick={onSkip}>
              Skip
              <kbd className="ml-1 rounded border px-1 text-[10px]">S</kbd>
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function DuplicateReviewList({
  proposed,
  recentMerges,
  recentDismissals,
}: {
  proposed: DuplicatePair[];
  recentMerges: RecentMerge[];
  recentDismissals: RecentDismissal[];
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

  const onUndoDismiss = (a: string, b: string) =>
    startTransition(async () => {
      try {
        await undoDismissDuplicatePair(a, b);
        toast.success("Back in the queue", { description: "You can look at this pair again" });
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.undoFailed));
      }
    });

  const probablyDifferent = proposed.filter(
    (p) => p.learned && p.learned.probability <= PROBABLY_DIFFERENT_AT
  );
  const keyOf = (p: DuplicatePair) => `${p.keep.id}:${p.merge.id}`;
  const [handled, setHandled] = useState<ReadonlySet<string>>(new Set());
  const [skipped, setSkipped] = useState<readonly string[]>([]);
  // One pair at a time, skipped ones last, so the queue is never more than a keystroke away.
  const left = proposed
    .filter((p) => !probablyDifferent.includes(p) && !handled.has(keyOf(p)))
    .sort((a, b) => Number(skipped.includes(keyOf(a))) - Number(skipped.includes(keyOf(b))));
  const current = left[0];
  const nothingToDo = proposed.length === 0;

  return (
    <div className="space-y-8">
      {nothingToDo ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="font-heading text-base">Nothing to review</p>
            <p className="mt-1 text-sm text-muted-foreground">Orbit merges clear duplicates itself.</p>
          </CardContent>
        </Card>
      ) : null}

      {current ? (
        <section className="space-y-3">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="font-heading text-lg">Possibly the same person</h2>
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {left.length} left
            </p>
          </div>
          <PairCard
            key={keyOf(current)}
            pair={current}
            onSkip={() => setSkipped((s) => [...s.filter((k) => k !== keyOf(current)), keyOf(current)])}
            onResolved={(revert) =>
              setHandled((h) => {
                const next = new Set(h);
                if (revert) next.delete(keyOf(current));
                else next.add(keyOf(current));
                return next;
              })
            }
          />
        </section>
      ) : null}

      {probablyDifferent.length > 0 ? (
        <details className="group space-y-3">
          <summary className="cursor-pointer font-heading text-lg">
            Probably different people ({probablyDifferent.length})
          </summary>
          <div className="mt-3 space-y-3">
            {probablyDifferent.map((pair) => (
              <PairCard key={`${pair.keep.id}:${pair.merge.id}`} pair={pair} />
            ))}
          </div>
        </details>
      ) : null}

      {recentMerges.length > 0 ? (
        <section className="space-y-3">
          <h2 className="font-heading text-lg">Recently merged</h2>
          <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
            {recentMerges.map((merge) => (
              <li key={merge.id} className="flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    <span className="text-muted-foreground">{merge.loserName ?? "A contact"}</span>
                    <ArrowRight className="mx-1.5 inline h-3 w-3" aria-hidden />
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
                  <Undo2 className="h-4 w-4" aria-hidden />
                  Undo
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {recentDismissals.length > 0 ? (
        <section className="space-y-3">
          <h2 className="font-heading text-lg">Marked as different people</h2>
          <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
            {recentDismissals.map((d) => (
              <li key={`${d.contactAId}:${d.contactBId}`} className="flex items-center gap-3 p-3">
                <p className="min-w-0 flex-1 truncate text-sm">
                  <IntentLink
                    href={`/contacts/${d.contactAId}`}
                    className="underline-offset-4 hover:underline"
                  >
                    {d.nameA}
                  </IntentLink>
                  {d.detailA ? <span className="text-muted-foreground"> ({d.detailA})</span> : null}
                  <span className="mx-1.5 text-muted-foreground">and</span>
                  <IntentLink
                    href={`/contacts/${d.contactBId}`}
                    className="underline-offset-4 hover:underline"
                  >
                    {d.nameB}
                  </IntentLink>
                  {d.detailB ? <span className="text-muted-foreground"> ({d.detailB})</span> : null}
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onUndoDismiss(d.contactAId, d.contactBId)}
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
