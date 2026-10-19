import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { RecruiterLogForm } from "@/components/recruiters/recruiter-log-form";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { RecruitersLocked } from "@/components/locked-feature";
import { PageHeader } from "@/components/layout/page-header";
import { PageShell } from "@/components/layout/page-shell";
import { Card, CardContent } from "@/components/ui/card";
import { RenderStamp } from "@/components/layout/render-stamp";

export default async function NewRecruiterPage() {
  const gate = await pageVisibilityGate("page.recruiters");
  if (gate) return gate;

  const { canUseRecruiters } = await getEntitlements(await requireUserId());
  if (!canUseRecruiters) return <RecruitersLocked />;

  return (
    <PageShell width="narrow">
      <RenderStamp />
      <PageHeader
        back={{ href: "/recruiters", label: "Back to recruiters" }}
        title="Add recruiter"
        description="Adds them to the shared directory. Your notes and rating stay private."
      />
      <Card>
        <CardContent>
          <RecruiterLogForm />
        </CardContent>
      </Card>
    </PageShell>
  );
}
