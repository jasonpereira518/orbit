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
import type { ClosenessBreakdown } from "@/lib/closeness";

export function ContactProfileOverview({
  contactId,
  aiSummary,
  keyFacts,
  sharedInterests,
  industry,
  closeness,
  lastTouchAt,
  frequencyLabel,
  howMetSummary,
}: {
  contactId: string;
  aiSummary: string | null;
  keyFacts: string[];
  sharedInterests: string[];
  industry: string | null;
  closeness: ClosenessBreakdown;
  lastTouchAt: Date | string | null;
  frequencyLabel: string;
  howMetSummary: string | null;
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
          <CardTitle>Who they are</CardTitle>
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
                      err instanceof Error
                        ? err.message
                        : "Could not generate summary"
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

      {keyFacts.length > 0 ? (
        <Card className="border-border/70 shadow-none">
          <CardHeader>
            <CardTitle>Key facts</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-primary">
              {keyFacts.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {sharedInterests.length > 0 ? (
        <Card className="border-border/70 shadow-none">
          <CardHeader>
            <CardTitle>Shared interests</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-primary">
              {sharedInterests.map((interest) => (
                <li key={interest}>{interest}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {industry?.trim() ? (
        <Card className="border-border/70 shadow-none">
          <CardHeader>
            <CardTitle>Industry</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-primary">{industry}</p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:col-span-2">
        <Card className="border-border/70 shadow-none">
          <CardHeader>
            <CardTitle>Closeness</CardTitle>
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
                  <p className="text-xs text-muted-foreground">Strength</p>
                  <p className="mt-0.5 text-lg font-medium text-primary">
                    {Math.round(closeness.strength * 100)}%
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Recency</p>
                  <p className="mt-0.5 text-sm text-primary">
                    Last interaction {recencyLabel}
                  </p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    Frequency · {frequencyLabel}
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {howMetSummary ? (
          <Card className="border-border/70 shadow-none">
            <CardHeader>
              <CardTitle>How you met</CardTitle>
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
