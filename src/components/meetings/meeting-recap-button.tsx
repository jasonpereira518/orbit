"use client";

/**
 * "Send recap" on a summarized meeting. Orbit writes it (from the digest) but never sends it:
 * with Compose released it opens there, addressed to the guests; until then the user gets it
 * in their own mail app, or copies it.
 */

import { useState } from "react";
import { Copy, Loader2, Mail } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { getMeetingRecap } from "@/actions/meetings";
import { openCompose } from "@/lib/compose-events";
import { recapMailto, type MeetingRecap } from "@/lib/meeting-recap";
import { toast } from "@/lib/toast";

export function MeetingRecapButton({ sessionId, composeLive }: { sessionId: string; composeLive: boolean }) {
  const [recap, setRecap] = useState<MeetingRecap | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    const res = await getMeetingRecap(sessionId);
    setLoading(false);
    if (!res.ok) return toast.error(res.error);
    if (composeLive) openCompose({ contactId: null, to: res.recap.to, subject: res.recap.subject, body: res.recap.body });
    else setRecap(res.recap);
  };

  const copy = async () => {
    if (!recap) return;
    try {
      await navigator.clipboard.writeText(`${recap.subject}\n\n${recap.body}`);
      toast.success("Recap copied");
    } catch {
      toast.error("Couldn’t copy — select the text instead");
    }
  };

  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={load} disabled={loading}>
        {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Mail className="size-3.5" />}
        Send recap
      </Button>
      {recap && (
        <div className="space-y-2 rounded-xl border border-border/70 bg-card p-3 text-sm">
          <p className="text-xs text-muted-foreground">
            {recap.to.length ? `To ${recap.to.join(", ")}` : "No guest emails on this meeting — add them in your mail app"}
          </p>
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap font-sans text-sm text-foreground">{recap.body}</pre>
          <div className="flex flex-wrap gap-2">
            <a href={recapMailto(recap)} className={buttonVariants({ size: "sm" })}>
              Open in email
            </a>
            <Button type="button" size="sm" variant="ghost" className="gap-1.5" onClick={copy}>
              <Copy className="size-3.5" /> Copy
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
