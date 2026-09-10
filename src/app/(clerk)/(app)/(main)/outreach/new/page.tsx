import { OutreachWizard } from "@/components/outreach/outreach-wizard";

export default function NewOutreachPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
          New outreach campaign
        </h1>
        <p className="mt-1 text-muted-foreground">
          Define a tight audience, a desired reply, and personalized drafts optimized for response rate
        </p>
      </div>
      <OutreachWizard />
    </div>
  );
}
