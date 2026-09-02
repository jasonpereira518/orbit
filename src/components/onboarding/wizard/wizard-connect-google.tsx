"use client";

import { GoogleContactsImport } from "@/components/imports/google-contacts-import";
import { Button } from "@/components/ui/button";

export function WizardConnectGoogle({
  contactLimit,
  onImported,
  onSkip,
}: {
  /** `settings.plan.contactLimit` from the page — `null` means unlimited. */
  contactLimit: number | null;
  onImported: (count: number) => void;
  onSkip: () => void;
}) {
  return (
    <div className="space-y-4">
      <p className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
        Orbit asks only to read your contacts — never your email.
      </p>

      <GoogleContactsImport
        returnTo="/onboarding/wizard"
        compact
        autoPreview
        onImportStarted={onImported}
        // GoogleContactsImport fires this once, only when the deployment has no Google
        // credentials — `googleConfigured` (the server prop gating this step out of
        // PATHS) is the primary switch, so this is a backstop for the rare case the
        // wizard resumed here anyway. Same destination as a deliberate skip.
        onUnavailable={onSkip}
      />

      {contactLimit != null ? (
        <p className="text-xs text-muted-foreground">
          The free plan holds up to {contactLimit} contacts; Orbit imports
          the first {contactLimit} and skips the rest.
        </p>
      ) : null}

      <div className="flex justify-end border-t border-border/60 pt-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={onSkip}
        >
          Skip for now
        </Button>
      </div>
    </div>
  );
}
