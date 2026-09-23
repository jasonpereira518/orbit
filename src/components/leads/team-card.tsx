"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Globe2, Lock } from "lucide-react";
import { leaveTeamAction, setTeamSharingAction } from "@/actions/teams";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/errors";
import type { TeamMemberRow, TeamMembership } from "@/lib/teams";
import { toast } from "@/lib/toast";
import { SharingDl } from "./sharing-dl";

/**
 * A member's view of their team: the sharing switch (reciprocal — the copy says so), who is
 * on it, and a two-step leave. Teammates are listed by name and sharing state only.
 */
export function TeamCard({
  membership,
  members,
  viewerUserId,
}: {
  membership: TeamMembership;
  members: TeamMemberRow[];
  viewerUserId: string;
}) {
  const router = useRouter();
  const [sharing, setSharing] = useState(membership.shareNetwork);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [pending, start] = useTransition();

  function toggleSharing() {
    const next = !sharing;
    start(async () => {
      setSharing(next);
      try {
        const result = await setTeamSharingAction(next);
        if (!result.ok) {
          setSharing(!next);
          toast.error(result.error);
          return;
        }
        toast.success(next ? "Your network is shared with the team" : "Your network is private again");
        router.refresh();
      } catch (err) {
        setSharing(!next);
        toast.error(friendlyError(err, "Couldn’t change sharing — try again?"));
      }
    });
  }

  function leave() {
    start(async () => {
      try {
        const result = await leaveTeamAction();
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        toast.success(`You left the ${membership.name} team`);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t leave the team — try again?"));
      } finally {
        setConfirmLeave(false);
      }
    });
  }

  const others = members.filter((m) => m.userId !== viewerUserId);
  const sharingOthers = others.filter((m) => m.sharing).length;
  const summary = !sharing
    ? others.length === 0
      ? "Your network is private. Share it and teammates who join later can find warm paths through you — it works both ways."
      : "Your network is private, so you won’t see who your teammates know either. Share it to find warm paths."
    : others.length === 0
      ? `You’re the first one here. Colleagues with a verified @${membership.domain} address can join.`
      : `Your network is shared. ${sharingOthers} of ${others.length} ${others.length === 1 ? "teammate shares" : "teammates share"} theirs with you.`;

  return (
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex gap-3">
          <div
            className={
              sharing
                ? "mt-0.5 h-9 w-9 shrink-0 rounded-full bg-primary/10 p-2 text-primary"
                : "mt-0.5 h-9 w-9 shrink-0 rounded-full bg-muted p-2 text-muted-foreground"
            }
          >
            {sharing ? <Globe2 className="h-5 w-5" aria-hidden /> : <Lock className="h-5 w-5" aria-hidden />}
          </div>
          <div className="min-w-0">
            <h2 className="font-medium text-ink">{membership.name} team</h2>
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">{summary}</p>
          </div>
        </div>
        <Button type="button" disabled={pending} variant={sharing ? "outline" : "default"} onClick={toggleSharing}>
          {pending ? "Saving…" : sharing ? "Stop sharing" : "Share my network"}
        </Button>
      </div>

      {members.length > 0 && (
        <ul className="divide-y divide-border/60 rounded-xl border border-border/60" aria-label="Team members">
          {members.map((member) => (
            <li key={member.userId} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
              <span className="min-w-0 truncate">
                <span className="font-medium text-ink">{member.userId === viewerUserId ? "You" : member.name}</span>
              </span>
              <Badge variant="outline" className="text-[10px]">
                {member.sharing ? "Sharing" : "Private"}
              </Badge>
            </li>
          ))}
        </ul>
      )}

      <SharingDl />

      <div className="flex justify-end">
        {confirmLeave ? (
          <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            Leave the {membership.name} team?
            <Button type="button" size="sm" variant="destructive" disabled={pending} onClick={leave}>
              Leave
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmLeave(false)}>
              Stay
            </Button>
          </span>
        ) : (
          <Button type="button" size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setConfirmLeave(true)}>
            Leave team
          </Button>
        )}
      </div>
    </section>
  );
}
