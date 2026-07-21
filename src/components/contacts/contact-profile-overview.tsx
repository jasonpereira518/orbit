"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { formatDistanceToNow } from "date-fns";
import { RefreshCw } from "lucide-react";
import { toast } from "@/lib/toast";
import { regenerateContactSummary } from "@/actions/contacts";
import { Button } from "@/components/ui/button";
import type { ClosenessBreakdown } from "@/lib/closeness";

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="border-t border-border/50 pt-6">
      <div className="mb-3 flex items-start justify-between gap-3">
        <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

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
    <div className="space-y-0">
      <Section
        title="Who they are"
        action={
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
        }
      >
        {aiSummary?.trim() ? (
          <p className="max-w-3xl text-[15px] leading-relaxed text-primary/90">
            {aiSummary}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            No summary yet. Add how you met or log an interaction, then generate
            one.
          </p>
        )}
      </Section>

      {keyFacts.length > 0 ? (
        <Section title="Key facts">
          <ul className="max-w-3xl list-disc space-y-1.5 pl-5 text-sm text-primary">
            {keyFacts.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      {sharedInterests.length > 0 ? (
        <Section title="Shared interests">
          <ul className="max-w-3xl list-disc space-y-1.5 pl-5 text-sm text-primary">
            {sharedInterests.map((interest) => (
              <li key={interest}>{interest}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      {industry?.trim() ? (
        <Section title="Industry">
          <p className="text-sm text-primary">{industry}</p>
        </Section>
      ) : null}

      <Section title="Closeness">
        <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
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
      </Section>

      {howMetSummary ? (
        <Section title="How you met">
          <p className="max-w-3xl text-sm leading-relaxed text-primary">
            {howMetSummary}
          </p>
        </Section>
      ) : null}
    </div>
  );
}
