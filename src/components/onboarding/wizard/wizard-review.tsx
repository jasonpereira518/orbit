"use client";

import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export type WizardResult =
  | { kind: "manual" }
  | { kind: "capture"; count: number }
  | { kind: "import" }
  | { kind: "google"; count: number };

function describe(result: WizardResult) {
  switch (result.kind) {
    case "manual":
      return "Added a contact manually.";
    case "capture":
      return result.count === 1
        ? "Added 1 person from your notes."
        : `Added ${result.count} people from your notes.`;
    case "import":
      return "Imported your LinkedIn connections.";
    case "google":
      return result.count === 1
        ? "Started importing 1 Google contact."
        : `Started importing ${result.count} Google contacts.`;
  }
}

export function WizardReview({
  results,
  onAddMore,
  onFinish,
  pending,
}: {
  results: WizardResult[];
  onAddMore: () => void;
  onFinish: () => void;
  pending: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-2xl border border-primary/25 bg-accent/60 p-5">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div>
          <p className="font-medium text-ink">Nice work</p>
          <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
            {results.length ? (
              results.map((r, i) => <li key={i}>{describe(r)}</li>)
            ) : (
              <li>You&apos;re ready to keep building your network.</li>
            )}
          </ul>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          className="bg-primary text-primary-foreground hover:bg-primary/90"
          disabled={pending}
          onClick={onFinish}
        >
          {pending ? "Finishing…" : "Go to dashboard"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={onAddMore}
        >
          Add more people
        </Button>
      </div>
    </div>
  );
}
