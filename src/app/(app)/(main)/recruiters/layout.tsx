import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { LockedFeature } from "@/components/locked-feature";

/**
 * The entitlement gate for every page under /recruiters.
 *
 * See the sibling layout under /outreach for why this is a layout: gating only
 * the index left `/recruiters/new` and `/recruiters/[id]` reachable, so a free
 * user got the full "Log a recruiter" form and a 500 on submit.
 *
 * The server actions keep their own `requireRecruitersUser()` checks — a layout
 * does not run for action POSTs, so this is a UI gate, not the security boundary.
 */
export default async function RecruitersLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { canUseRecruiters } = await getEntitlements(await requireUserId());

  if (!canUseRecruiters) {
    return (
      <LockedFeature
        title="Recruiter tracking"
        description="A crowdsourced directory of recruiters, plus a record of every conversation you've had with each of them."
        highlights={[
          "Search recruiters by company and specialism",
          "Log interactions and unlock contact details",
          "Pull recruiter threads straight out of Gmail",
          "See who has gone quiet and who is worth a nudge",
        ]}
      />
    );
  }

  return <>{children}</>;
}
