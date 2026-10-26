import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { LockedFeature } from "@/components/locked-feature";

/**
 * The entitlement gate for every page under /outreach.
 *
 * It lives in the layout rather than in each page because gating only the index
 * left `/outreach/new` and `/outreach/[id]` wide open: a free user could fill in
 * the entire campaign form and only discover the paywall when submitting threw a
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
        description="Describe who you want to reach, find real people to write to, and send from your own email — then see who answers."
        highlights={[
          "Find people from a sentence, each with the page that shows the match",
          "Drafts written from real details about each person, in your voice",
          "Sent from your own Gmail or Outlook, with LinkedIn notes you copy and send yourself",
          "Replies found for you, and one follow-up in the same thread",
        ]}
        note="Email goes out from your own mailbox, so replies land where you already read them."
      />
    );
  }

  return <>{children}</>;
}
