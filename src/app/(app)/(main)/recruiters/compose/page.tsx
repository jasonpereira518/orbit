import Link from "next/link";
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
        note="Included in Orbit Pro and Orbit Lifetime."
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
      <div>
        <Link
          href="/recruiters"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Recruiters
        </Link>
        <h1 className="mt-2 font-[family-name:var(--font-display)] text-3xl text-ink">
          Compose
        </h1>
        <p className="mt-1 text-muted-foreground">
          Draft emails to recruiters you&apos;ve logged, then review and send them from
          your own Gmail.
        </p>
      </div>

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
