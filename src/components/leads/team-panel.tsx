import type { TeamEligibility, TeamMemberRow } from "@/lib/teams";
import { JoinTeamCard } from "./join-team-card";
import { TeamCard } from "./team-card";

/** The top of /leads: a member's team, the offer to join one, or why they can’t yet. */
export function TeamPanel({
  eligibility,
  members,
  viewerUserId,
}: {
  eligibility: TeamEligibility;
  members: TeamMemberRow[];
  viewerUserId: string;
}) {
  if (eligibility.kind === "member") {
    return <TeamCard key={String(eligibility.membership.shareNetwork)} membership={eligibility.membership} members={members} viewerUserId={viewerUserId} />;
  }
  if (eligibility.kind === "eligible") {
    return (
      <JoinTeamCard
        domain={eligibility.domain}
        name={eligibility.name}
        memberCount={eligibility.existing?.memberCount ?? 0}
      />
    );
  }
  return (
    <section className="rounded-2xl border border-dashed border-border/70 bg-card px-5 py-6">
      <h2 className="font-medium text-ink">Teams need a work email</h2>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        {eligibility.reason === "public_domain"
          ? "A team is everyone at one company’s email domain, so a personal address like Gmail can’t form one. Add your work email in your account settings and verify it."
          : "Verify your work email in your account settings, then come back to join your team."}
      </p>
    </section>
  );
}
