import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import {
  getGmailConnectionStatus,
  getGmailSendIdentity,
} from "@/actions/gmail";
import {
  getRecruiterSendQuota,
  listRecruiterDrafts,
} from "@/actions/recruiter-messages";
import { RECRUITER_INTENT_OPTIONS } from "@/lib/recruiter-message-types";
import { listMyRecruiters } from "@/actions/recruiters";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { RecruitersLocked } from "@/components/locked-feature";
import { ComposeWorkspace } from "@/components/recruiters/compose-workspace";
import { PageHeader } from "@/components/layout/page-header";
import { PageShell } from "@/components/layout/page-shell";
import { RenderStamp } from "@/components/layout/render-stamp";

export default async function RecruiterComposePage() {
  const gate = await pageVisibilityGate("page.recruiters");
  if (gate) return gate;

  // The layout already gates this route; the check here matches the sibling pages so a
  // direct hit can never render the workspace for a plan without it.
  const { canUseRecruiters } = await getEntitlements(await requireUserId());
  if (!canUseRecruiters) return <RecruitersLocked />;

  const [mine, drafts, quota, gmail, identity] = await Promise.all([
    listMyRecruiters(),
    listRecruiterDrafts(),
    getRecruiterSendQuota(),
    getGmailConnectionStatus(),
    getGmailSendIdentity(),
  ]);

  return (
    <PageShell width="default">
      <RenderStamp />
      <PageHeader
        back={{ href: "/recruiters", label: "Back to recruiters" }}
        title="Compose"
        description="Draft emails to recruiters you’ve logged, then review and send them from your own Gmail."
      />

      <ComposeWorkspace
        recruiters={mine.map((r) => ({
          id: r.id,
          fullName: r.fullName,
          firm: r.firm,
          email: r.email,
          hasHistory: Boolean(r.myLink?.aiSummary),
        }))}
        initialDrafts={drafts}
        intents={[...RECRUITER_INTENT_OPTIONS]}
        quota={quota}
        canSend={gmail.canSend}
        identity={identity}
      />
    </PageShell>
  );
}
