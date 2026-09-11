import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { LockedFeature } from "@/components/locked-feature";

/**
 * The entitlement gate for every page under /outreach.
 *
 * It lives in the layout rather than in each page because gating only the index
 * left `/outreach/new` and `/outreach/[id]` wide open: a free user could fill in
 * the entire campaign wizard and only discover the paywall when Continue threw a
 * 500 from `requireOutreachUser()` inside the action. Nothing was written — the
 * actions are gated correctly — but it is a dead end for exactly the people who
 * are trying to give you money, and in production Next redacts a thrown action's
 * message, so they would not even be told to upgrade.
 *
 * Putting it here means any sub-page added later inherits the gate by default.
 * The server actions keep their own checks: a layout does not run for action
 * POSTs, so it is a UI gate, never the security boundary.
 */
export default async function OutreachLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { canUseOutreach } = await getEntitlements(await requireUserId());

  if (!canUseOutreach) {
    return (
      <LockedFeature
        title="Outreach"
        description="Find the right people, draft messages that sound like you, and track what actually gets replies — without leaving Orbit."
        highlights={[
          "Search prospects by role, company, and seniority",
          "Personalized email and SMS drafts from your own notes",
          "Reply tracking and per-campaign quality scores",
          "Sequenced follow-ups that stop when someone replies",
        ]}
        note="Both send email and SMS on Orbit's credits. On Orbit Lifetime you supply your own Apollo key for prospect search."
      />
    );
  }

  return <>{children}</>;
}
