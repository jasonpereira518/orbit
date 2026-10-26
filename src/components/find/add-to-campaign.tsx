"use client";

import { useEffect, useRef, useTransition } from "react";
import { ListPlus, Loader2 } from "lucide-react";
import { addProspects } from "@/actions/outreach-people";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { friendlyError } from "@/lib/errors";
import { channelLabel } from "@/lib/outreach-channels";
import type { CampaignChoice } from "@/lib/outreach-types";
import { toast } from "@/lib/toast";

/** A person from /find in the shape `addProspects` takes: found by description, or briefed. */
export type AddablePerson = {
  fullName: string;
  title?: string | null;
  company?: string | null;
  linkedinUrl?: string | null;
  origin: "find" | "brief";
  url?: string;
  whyMatches?: string;
  researchKey?: string;
};

/**
 * Put one person on one of the user's campaigns. The choices come from the page as props (the
 * query behind them reaches the database, which a client component must not), and with none
 * there is no button at all.
 */
export function AddToCampaign({ person, choices }: { person: AddablePerson; choices: CampaignChoice[] }) {
  const [pending, start] = useTransition();
  const trigger = useRef<HTMLButtonElement>(null);
  const wasPending = useRef(false);

  // A disabled button cannot keep focus, and the menu hands focus back to it as it closes. Once
  // the add is done the button takes it again, unless the person has already gone elsewhere.
  useEffect(() => {
    if (pending) {
      wasPending.current = true;
      return;
    }
    if (!wasPending.current) return;
    wasPending.current = false;
    if (!document.activeElement || document.activeElement === document.body) trigger.current?.focus();
  }, [pending]);

  if (!choices.length) return null;

  const add = (campaign: CampaignChoice) =>
    start(async () => {
      try {
        const res = await addProspects(campaign.id, [person]);
        if (!res.ok) return void toast.error(res.error);
        const { added, invalid } = res.value;
        if (invalid) toast.error("Couldn’t add them — they need a company or LinkedIn link");
        else if (added) toast.success(`Added to ${campaign.name}`);
        else toast.message(`Already in ${campaign.name}`);
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t add them — try again?"));
      }
    });

  return (
    <DropdownMenu disabled={pending}>
      <DropdownMenuTrigger
        render={
          <Button ref={trigger} variant="outline" size="sm" aria-label={`Add to campaign: ${person.fullName}`} aria-busy={pending}>
            {pending ? <Loader2 className="animate-spin" aria-hidden /> : <ListPlus aria-hidden />}
            Add to campaign
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-auto min-w-48 max-w-72">
        {choices.map((c) => (
          <DropdownMenuItem key={c.id} onClick={() => add(c)}>
            <span className="min-w-0 flex-1 break-words">{c.name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{channelLabel(c.channel)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
