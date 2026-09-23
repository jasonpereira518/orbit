"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Handshake } from "lucide-react";
import { joinTeamAction } from "@/actions/teams";
import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { SharingDl } from "./sharing-dl";

/** The offer to join the viewer's domain team, with the sharing choice made up front. */
export function JoinTeamCard({ domain, name, memberCount }: { domain: string; name: string; memberCount: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [choice, setChoice] = useState<boolean | null>(null);

  function join(shareNetwork: boolean) {
    setChoice(shareNetwork);
    start(async () => {
      try {
        const result = await joinTeamAction({ shareNetwork });
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast.success(shareNetwork ? `You’re on the ${name} team, sharing your network` : `You’re on the ${name} team`);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t join the team â try again?"));
      }
    });
  }

  const already =
    memberCount > 0
      ? `${memberCount} ${memberCount === 1 ? "colleague is" : "colleagues are"} already on it.`
      : "You'd be the first.";

  return (
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-5">
      <div className="flex gap-3">
        <div className="mt-0.5 h-9 w-9 shrink-0 rounded-full bg-primary/10 p-2 text-primary">
          <Handshake className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0">
          <h2 className="font-medium text-ink">Join the {name} team</h2>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            Everyone with a verified @{domain} address lands on the same team. {already} Share
            your network to see who your teammates know — it works both ways.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={pending} onClick={() => join(true)}>
          {pending && choice === true ? "Joining…" : "Join and share my network"}
        </Button>
        <Button type="button" variant="outline" disabled={pending} onClick={() => join(false)}>
          {pending && choice === false ? "Joining…" : "Join without sharing"}
        </Button>
      </div>
      <SharingDl />
    </section>
  );
}
