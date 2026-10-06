"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { formatDistanceToNow } from "date-fns";
import { Handshake, Orbit, RefreshCw } from "lucide-react";
import { toast } from "@/lib/toast";
import { regenerateContactSummary } from "@/actions/contacts";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EditableFactList } from "@/components/contacts/editable-fact-list";
import type { ClosenessBreakdown } from "@/lib/closeness";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";

export function ContactProfileOverview({
  contactId,
  aiSummary,
  keyFacts,
  sharedInterests,
  industry,
  closeness,
  lastTouchAt,
  hasLoggedInteraction,
  frequencyLabel,
  howMetSummary,
  isRated,
}: {
  contactId: string;
  aiSummary: string | null;
  keyFacts: string[];
  sharedInterests: string[];
  industry: string | null;
  closeness: ClosenessBreakdown;
  lastTouchAt: Date | string | null;
  /** See ContactStatPills — `lastTouchAt` alone cannot tell the two cases apart. */
  hasLoggedInteraction: boolean;
  frequencyLabel: string;
  howMetSummary: string | null;
  /**
   * Whether a human has actually rated this person 1-5.
   *
   * `strengthComponent` substitutes NEUTRAL_STRENGTH (0.5) when nobody has, and
   * `lib/closeness.ts` says in as many words that this is "for display" and that an
   * unrated contact's weight is redistributed rather than filled in with a guess. The
   * card rendered that 0.5 as a flat "Strength 50%", which reads as a measurement of the
   * relationship rather than the absence of one.
   */
  isRated: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const recencyLabel = lastTouchAt
    ? formatDistanceToNow(new Date(lastTouchAt), { addSuffix: true })
    : "Never";

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="border-border/70 shadow-none lg:col-span-2">
        <CardHeader className="border-b border-border/50">
          <CardTitle as="h2">Who they are</CardTitle>
          <CardAction>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs text-muted-foreground"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  try {
                    await regenerateContactSummary(contactId);
                    toast.success("Summary updated");
                    router.refresh();
                  } catch (err) {
                    toast.error(
                      friendlyError(err, TOAST_COPY.summaryFailed)
                    );
                  }
                })
              }
            >
              <RefreshCw className={`size-3 ${pending ? "animate-spin" : ""}`} />
              {pending ? "Updating…" : aiSummary ? "Refresh" : "Generate"}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {aiSummary?.trim() ? (
            <p className="max-w-3xl text-[15px] leading-relaxed text-primary/90">
              {aiSummary}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              No summary yet. Add how you met or log an interaction, then
              generate one.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Rendered even when empty, unlike before. These are the fields the AI fills in, and
          a card that only appears once something already exists gives the user no way to
          add the first entry — or to discover that Orbit tracks this at all.

          Opportunities are NOT edited here. This branch added a third card for them, before
          main's meeting-notes work made `contacts.opportunities` a derived mirror of the
          `contact_opportunities` table — so an edit written straight to the column would be
          silently overwritten the next time that mirror was rebuilt. They have their own
          typed section on this page now (`contact-opportunities-section.tsx`). */}
      <EditableFactList
        contactId={contactId}
        field="keyFacts"
        title="Key facts"
        addLabel="Add fact"
        emptyHint="Nothing yet. Log an interaction and Orbit will pull these out — or add what matters yourself."
        items={keyFacts}
      />

      <EditableFactList
        contactId={contactId}
        field="sharedInterests"
        title="Shared interests"
        addLabel="Add interest"
        emptyHint="Nothing yet. These are what you have in common — useful openers when you next reach out."
        items={sharedInterests}
      />


      {industry?.trim() ? (
        <Card className="border-border/70 shadow-none">
          <CardHeader>
            <CardTitle as="h2">Industry</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-ink">{industry}</p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:col-span-2">
        <Card className="border-border/70 shadow-none">
          <CardHeader>
            <CardTitle as="h2">Closeness</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-start gap-4">
              <div
                className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-primary/8 text-primary"
                aria-hidden
              >
                <Orbit className="size-8 stroke-[1.5]" />
              </div>
              <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">
                <div>
                  {/* "Your rating", not "Strength": this is the 1-5 the user set, which
                      is one weighted component of the closeness score shown in the header
                      pill. Two different numbers under two labels that both read as
                      "how close are we" was the confusion. */}
                  <p className="text-xs text-muted-foreground">Your rating</p>
                  {isRated ? (
                    <p className="mt-0.5 text-lg font-medium text-ink">
                      {Math.round(closeness.strength * 100)}%
                    </p>
                  ) : (
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      Not rated yet
                    </p>
                  )}
                </div>
                <div>
                  {/* Both lines feed the score: recency and cadence are
                      separate components of closeness. */}
                  <p className="text-xs text-muted-foreground">Activity</p>
                  {hasLoggedInteraction ? (
                    <>
                      <p className="mt-0.5 text-sm text-ink">
                        Last interaction {recencyLabel}
                      </p>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        Frequency · {frequencyLabel}
                      </p>
                    </>
                  ) : (
                    <>
                      {/* Nothing logged. Saying "last interaction 23 days ago" here —
                          off an import stamp — next to a timeline reading "no
                          interactions yet" is the kind of contradiction that costs
                          trust in every other number on the page. */}
                      <p className="mt-0.5 text-sm text-ink">
                        No interactions logged
                      </p>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {lastTouchAt
                          ? `In your network ${recencyLabel}`
                          : "Log an interaction to start the history"}
                      </p>
                    </>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {howMetSummary ? (
          <Card className="border-border/70 shadow-none">
            <CardHeader>
              <CardTitle as="h2">How you met</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-start gap-4">
                <div
                  className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-primary/8 text-primary"
                  aria-hidden
                >
                  <Handshake className="size-8 stroke-[1.5]" />
                </div>
                <p className="min-w-0 flex-1 text-sm leading-relaxed text-primary">
                  {howMetSummary}
                </p>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
