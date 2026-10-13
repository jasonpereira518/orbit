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
import { LockedFeature } from "@/components/locked-feature";
import { ComposeWorkspace } from "@/components/recruiters/compose-workspace";
import { RenderStamp } from "@/components/layout/render-stamp";
import { PageHeader } from "@/components/layout/page-header";

export default async function RecruiterComposePage() {
  const { canUseRecruiters } = await getEntitlements(await requireUserId());
  if (!canUseRecruiters) {
    return (
      <LockedFeature
        title="Recruiter outreach"
        description="Draft and send emails to the recruiters you already know, written from your actual history with them."
        highlights={[
          "Pick an intent — a chat, a referral, upcoming roles, interview prep",
          "Drafts are written from your own conversation history",
          "Review every message before anything sends",
          "Sends from your Gmail, threaded into the original conversation",
        ]}
        note="Included in Orbit Pro and Orbit Max."
      />
    );
  }

  const [mine, drafts, quota, gmail, identity] = await Promise.all([
    listMyRecruiters(),
    listRecruiterDrafts(),
    getRecruiterSendQuota(),
    getGmailConnectionStatus(),
    getGmailSendIdentity(),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <RenderStamp />
      <PageHeader
        back={{ href: "/recruiters", label: "Recruiters" }}
        title="Compose"
        subtitle="Draft emails to recruiters you’ve logged, then review and send them from your own Gmail."
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
    </div>
  );
}
