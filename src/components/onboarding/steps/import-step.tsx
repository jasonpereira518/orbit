"use client";

import { useState } from "react";
import { LinkedInConnectionsImport } from "@/components/imports/linkedin-connections-import";
import { LinkedInMessagesImport } from "@/components/imports/linkedin-messages-import";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useImportJob } from "@/lib/import-job-runner";

/**
 * The "upload your LinkedIn export" branch of onboarding.
 *
 * `onContinue(started)` reports whether a LinkedIn import actually began here. It used to
 * record "Imported your LinkedIn connections" for anyone who pressed Continue, including
 * people who uploaded nothing — the done step now only says so when a job ran.
 */
export function ImportStep({ onContinue }: { onContinue: (started: boolean) => void }) {
  const job = useImportJob();
  // Latches: the job snapshot clears when an import finishes, and a finished import still
  // counts. Set during render (React's derived-state pattern) rather than in an effect.
  const [started, setStarted] = useState(false);
  if (!started && job && (job.kind === "connections" || job.kind === "messages")) {
    setStarted(true);
  }

  return (
    <div className="space-y-4">
      <p className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground">
        Upload the ZIP LinkedIn emailed you as it arrived. Orbit finds Connections.csv and
        messages.csv inside it, so there&apos;s no need to unzip anything.
      </p>
      <LinkedInConnectionsImport />

      <div className="flex items-center gap-2 px-1 pt-2">
        <Badge variant="secondary" className="shrink-0">
          Recommended
        </Badge>
        <p className="text-sm text-muted-foreground">
          Connections tell Orbit who you know. Messages tell it who you
          actually talk to — upload them too and Orbit can tell your closest
          contacts apart from day one.
        </p>
      </div>
      <LinkedInMessagesImport />

      <div className="flex justify-end border-t border-border/60 pt-4">
        <Button type="button" size="lg" className="h-10 px-4" onClick={() => onContinue(started)}>
          {started ? "Continue" : "Skip for now"}
        </Button>
      </div>
    </div>
  );
}
