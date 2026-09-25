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
    // Side by side from lg, so the step fits one screen; each card grows on its own once a
    // file is picked. The way on sits under the shorter Connections card rather than below
    // both, which would add a row under the taller Messages column.
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <div className="space-y-4">
        <LinkedInConnectionsImport />
        <div className="flex justify-end">
          <Button type="button" size="lg" className="h-10 px-4" onClick={() => onContinue(started)}>
            {started ? "Continue" : "Skip for now"}
          </Button>
        </div>
      </div>
      <div className="space-y-2">
        <LinkedInMessagesImport />
        <p className="flex items-start gap-2 px-1 text-xs text-muted-foreground">
          <Badge variant="secondary" className="shrink-0">
            Recommended
          </Badge>
          Connections tell Orbit who you know. Messages tell it who you actually talk to, so
          your closest contacts stand out from day one.
        </p>
      </div>
    </div>
  );
}
