"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "@/lib/toast";
import { autofillContactsWithAi, listAiFillTargets } from "@/actions/contacts";
import { AI_FILL_BATCH_SIZE } from "@/lib/contact-ai-fill";
import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/errors";

/**
 * Bulk "Autofill with AI": web-research saved contacts that have a gap in company, role,
 * location or school, and fill only the empty fields. Capped server-side per click.
 */
export function AiFillContactsButton() {
  const router = useRouter();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  async function run() {
    if (progress) return;
    setProgress({ done: 0, total: 0 });
    try {
      const ids = await listAiFillTargets();
      if (ids.length === 0) {
        toast.message("Nothing to fill", {
          description: "Contacts with a company or LinkedIn link already have their details",
        });
        return;
      }
      setProgress({ done: 0, total: ids.length });
      let filled = 0;
      let stopped: "no_ai" | "rate_limited" | null = null;
      for (let i = 0; i < ids.length && !stopped; i += AI_FILL_BATCH_SIZE) {
        const chunk = ids.slice(i, i + AI_FILL_BATCH_SIZE);
        const result = await autofillContactsWithAi(chunk);
        filled += result.filled;
        stopped = result.stopped;
        setProgress({ done: Math.min(i + chunk.length, ids.length), total: ids.length });
      }
      if (filled > 0) {
        toast.success(`Filled details for ${filled} contact${filled === 1 ? "" : "s"}`);
        router.refresh();
      } else if (!stopped) {
        toast.message("Couldn’t find anything new", {
          description: "No confident matches for these contacts",
        });
      }
      if (stopped === "no_ai") toast.message("Autofill needs AI — add a key in Settings → AI");
      if (stopped === "rate_limited") toast.message("You’ve used today’s research lookups — try again tomorrow");
    } catch (err) {
      toast.error(friendlyError(err, "Couldn’t autofill your contacts — try again?"));
    } finally {
      setProgress(null);
    }
  }

  const busy = progress !== null;
  return (
    <>
      <span role="status" className="sr-only">
        {busy ? "Autofilling contacts with AI" : ""}
      </span>
      <Button type="button" variant="outline" disabled={busy} aria-busy={busy} className="gap-1.5" onClick={() => void run()}>
        <Sparkles className="h-4 w-4" aria-hidden />
        {progress && progress.total > 0 ? `${progress.done}/${progress.total}` : busy ? "Searching…" : "Autofill"}
      </Button>
    </>
  );
}
