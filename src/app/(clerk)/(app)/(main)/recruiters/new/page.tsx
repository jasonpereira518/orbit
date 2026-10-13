import { RecruiterLogForm } from "@/components/recruiters/recruiter-log-form";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { RecruitersLocked } from "@/components/locked-feature";
import { RenderStamp } from "@/components/layout/render-stamp";
import { PageHeader } from "@/components/layout/page-header";

export default async function NewRecruiterPage() {
  const { canUseRecruiters } = await getEntitlements(await requireUserId());
  if (!canUseRecruiters) return <RecruitersLocked />;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <RenderStamp />
      <PageHeader
        back={{ href: "/recruiters", label: "Recruiters" }}
        title="Log a recruiter"
        subtitle="Adds them to the shared directory. Your notes and rating stay private."
      />
      <div className="rounded-2xl border border-border/70 bg-card p-5">
        <RecruiterLogForm />
      </div>
    </div>
  );
}
