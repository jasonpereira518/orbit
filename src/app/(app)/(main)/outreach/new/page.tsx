import { OutreachWizard } from "@/components/outreach/outreach-wizard";

export default function NewOutreachPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">
          New outreach campaign
        </h1>
        <p className="mt-1 text-muted-foreground">
          Define your audience, find prospects, and generate personalized drafts
        </p>
      </div>
      <OutreachWizard />
    </div>
  );
}
