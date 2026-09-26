"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { EyeOff, Loader2, Users } from "lucide-react";
import { setContactTeamSharedAction } from "@/actions/teams";
import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/errors";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * The per-contact exception to team sharing, beside the constellation pin and shaped like it.
 * "Visible" means a teammate who looks this person up learns that you know them and how
 * closely — nothing else. The contact page decides whether to show it at all.
 */
export function TeamShareButton({ contactId, shared }: { contactId: string; shared: boolean }) {
  const router = useRouter();
  const [current, setCurrent] = useState(shared);
  const [pending, start] = useTransition();

  function toggle() {
    const next = !current;
    setCurrent(next);
    start(async () => {
      try {
        const result = await setContactTeamSharedAction(contactId, next);
        if (!result.ok) {
          setCurrent(!next);
          toast.error(result.error);
          return;
        }
        router.refresh();
      } catch (err) {
        setCurrent(!next);
        toast.error(friendlyError(err, "Couldn’t change that — try again?"));
      }
    });
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending}
      // The label says where they are; the action is the opposite, so spell it out for screen readers.
      aria-label={current ? "Hide this person from your team" : "Let your team see that you know this person"}
      title={
        current
          ? "While you share your network, teammates who look this person up can see that you know them, and how closely — click to hide"
          : "Hidden from your team — click to let teammates see that you know them"
      }
      onClick={toggle}
      className={cn("rounded-full", !current && "text-muted-foreground")}
    >
      {pending ? <Loader2 className="animate-spin" aria-hidden /> : current ? <Users aria-hidden /> : <EyeOff aria-hidden />}
      {current ? "Visible to team" : "Hidden from team"}
    </Button>
  );
}
