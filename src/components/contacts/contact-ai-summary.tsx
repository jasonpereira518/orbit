"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "@/lib/toast";
import { regenerateContactSummary } from "@/actions/contacts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function ContactAiSummary({
  contactId,
  summary,
}: {
  contactId: string;
  summary: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <Card className="border-border/70 shadow-none">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">AI summary</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Who they are, how you met, and what you&apos;ve talked about.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              try {
                await regenerateContactSummary(contactId);
                toast.success("Summary updated");
                router.refresh();
              } catch (err) {
                toast.error(
                  err instanceof Error ? err.message : "Could not generate summary"
                );
              }
            })
          }
        >
          {pending ? "Generating…" : summary ? "Refresh" : "Generate"}
        </Button>
      </CardHeader>
      <CardContent>
        {summary ? (
          <p className="text-sm leading-relaxed text-muted-foreground">
            {summary}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            No summary yet. Add how you met or log an interaction, then generate
            one.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
