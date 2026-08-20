"use client";

import { LinkedInConnectionsImport } from "@/components/imports/linkedin-connections-import";
import { LINKEDIN_DATA_URL } from "@/components/imports/linkedin-export-guide";
import { Button } from "@/components/ui/button";

export function WizardImport({ onContinue }: { onContinue: () => void }) {
  return (
    <div className="space-y-4">
      <p className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
        LinkedIn exports usually take about 24 hours.{" "}
        <a
          href={LINKEDIN_DATA_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-primary underline-offset-2 hover:underline"
        >
          Request your export now
        </a>
        , then come back and upload it here once LinkedIn emails you.
      </p>
      <LinkedInConnectionsImport />
      <div className="flex justify-end border-t border-border/60 pt-4">
        <Button
          type="button"
          className="bg-primary text-primary-foreground hover:bg-primary/90"
          onClick={onContinue}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}
