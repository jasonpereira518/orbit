"use client";

import { useState } from "react";
import { AiKeyNotice } from "@/components/ai-key-notice";
import { CaptureFlowLazy } from "@/components/capture/capture-flow-lazy";
import { ContactForm } from "@/components/contacts/contact-form";
import { Button } from "@/components/ui/button";
import type { CaptureJobView } from "@/lib/capture-jobs";
import type { AiAccessDenial } from "@/lib/managed-ai-policy";

/**
 * Quick setup's first person. Usually /capture's own flow, notes only: extracting writes a
 * durable capture job, so a reload mid-review comes back to the same cards (`initialJob`),
 * exactly as /capture resumes.
 *
 * When AI cannot run for this account, the notes box would only show a disabled button, so
 * the step leads with the short by-hand form instead — name, how you met, when to follow up —
 * and still ends in a real person with a follow-up. A LinkedIn profile URL works without AI,
 * so the notes box stays one click away for that.
 */
export function CaptureStep({
  initialJob,
  hasApiKey,
  aiReason,
  onSaved,
  onManual,
  onOtherWays,
}: {
  initialJob: CaptureJobView | null;
  hasApiKey: boolean;
  aiReason: AiAccessDenial | null;
  /** A capture saved, or a person added by hand. */
  onSaved: () => void;
  onManual: () => void;
  onOtherWays: () => void;
}) {
  const [notesAnyway, setNotesAnyway] = useState(false);
  const linkClass = "h-auto p-0 text-sm";

  if (!hasApiKey && !notesAnyway) {
    return (
      <div className="space-y-4">
        <AiKeyNotice feature="capture" reason={aiReason} />
        <ContactForm compact followUpChoice submitLabel="Add them" redirectOnSuccess={false} onSuccess={() => onSaved()} />
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span>
            Have their LinkedIn profile?{" "}
            <Button type="button" variant="link" className={linkClass} onClick={() => setNotesAnyway(true)}>
              Paste the URL instead
            </Button>
            , no AI needed.
          </span>
          <Button type="button" variant="link" className={linkClass} onClick={onOtherWays}>
            Other ways to add people
          </Button>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <CaptureFlowLazy
        initialJob={initialJob}
        hasApiKey={hasApiKey}
        aiReason={aiReason}
        meetingsDeniedMessage=""
        onSaved={onSaved}
      />
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <Button type="button" variant="link" className={linkClass} onClick={onManual}>
          Type their details instead
        </Button>
        <Button type="button" variant="link" className={linkClass} onClick={onOtherWays}>
          Other ways to add people
        </Button>
      </p>
    </div>
  );
}
