import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import { LeadsHeader } from "@/components/leads/leads-header";

export default async function LeadsPage() {
  // First, before anything else: a click straight from a sibling route skips the
  // layout-level check (see `pageVisibilityGate`), and nothing below should run for a
  // page that is not out yet.
  const gate = await pageVisibilityGate("page.leads");
  if (gate) return gate;

  // The real page lands in later phases (see docs/superpowers/specs/2026-09-22-leads-design.md).
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <LeadsHeader />
      <div className="rounded-xl border border-dashed border-border/70 px-4 py-10 text-center">
        <p className="text-sm text-muted-foreground">Nothing here yet.</p>
      </div>
    </div>
  );
}
