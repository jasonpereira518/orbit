"use client";

import { useState, useTransition } from "react";
import { ExternalLink } from "lucide-react";
import {
  markLinkedInExportRequested,
  scheduleLinkedInExportReminder,
} from "@/actions/linkedin-export";
import { LINKEDIN_DATA_URL } from "@/components/imports/linkedin-export-guide";
import { toast } from "@/lib/toast";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { WizardResult } from "@/components/onboarding/wizard/wizard-review";

/**
 * The LinkedIn export takes about a day, so this step never blocks on it: either button
 * can fire independently (or both, in either order) before the user moves on. The result
 * recorded for the review step reflects whatever happened, computed once at exit —
 * `linkedin-requested` if a reminder ended up scheduled (which also means the export was
 * requested, since `scheduleLinkedInExportReminder` stamps that itself), otherwise
 * `linkedin-requested-no-reminder` if only the export was requested, otherwise none.
 */
export function WizardLinkedInLater({
  onContinue,
  onImportNow,
}: {
  onContinue: (result: WizardResult | null) => void;
  onImportNow: (result: WizardResult | null) => void;
}) {
  const [requested, setRequested] = useState(false);
  const [reminded, setReminded] = useState(false);
  const [pending, startTransition] = useTransition();

  function requestExport() {
    setRequested(true);
    void markLinkedInExportRequested().catch(() => {});
  }

  function remindTomorrow() {
    startTransition(async () => {
      try {
        await scheduleLinkedInExportReminder();
        setReminded(true);
        setRequested(true);
        toast.success("We'll remind you tomorrow");
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not set a reminder"
        );
      }
    });
  }

  function result(): WizardResult | null {
    if (reminded) return { kind: "linkedin-requested" };
    if (requested) return { kind: "linkedin-requested-no-reminder" };
    return null;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        LinkedIn builds the export in the background and emails you a link,
        usually within a day.
      </p>

      <div className="flex flex-wrap gap-2">
        <a
          href={LINKEDIN_DATA_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={requestExport}
          className={cn(
            buttonVariants({ variant: "outline" }),
            "gap-1.5"
          )}
        >
          Request export on LinkedIn
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={remindTomorrow}
        >
          {pending ? "Setting reminder…" : "Remind me tomorrow"}
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-4">
        <Button
          type="button"
          variant="ghost"
          className="text-muted-foreground"
          onClick={() => onImportNow(result())}
        >
          I already have the file
        </Button>
        <Button
          type="button"
          className="bg-primary text-primary-foreground hover:bg-primary/90"
          onClick={() => onContinue(result())}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}
