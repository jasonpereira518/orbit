import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import Form from "next/form";
import Link from "next/link";
import { Search } from "lucide-react";
import { LockedFeature } from "@/components/locked-feature";
import { MeetingsList } from "@/components/meetings/meetings-list";
import { RenderStamp } from "@/components/layout/render-stamp";
import { PageHeader } from "@/components/layout/page-header";
import { PageShell } from "@/components/layout/page-shell";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireUserId } from "@/lib/auth";
import { FEATURE_DENIAL, getEntitlements } from "@/lib/entitlements";
import { getResumableMeeting } from "@/lib/meeting-sessions";
import { listMeetingsFor } from "@/lib/meetings-list";

export default async function MeetingsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const gate = await pageVisibilityGate("page.meetings");
  if (gate) return gate;

  const { q: rawQ } = await searchParams;
  const q = (rawQ ?? "").trim().slice(0, 100);
  const userId = await requireUserId();
  const { canUseMeetings } = await getEntitlements(userId);

  if (!canUseMeetings) {
    return (
      <PageShell width="default">
        <RenderStamp />
        <PageHeader title="Meetings" />
        <LockedFeature
          title="Meeting history"
          description={FEATURE_DENIAL.meetings}
          highlights={[
            "Every call you recorded, kept and searchable",
            "Search by person, topic or what was said",
            "Ask Chat what came up in a meeting",
          ]}
        />
      </PageShell>
    );
  }

  const [page, unfinished] = await Promise.all([
    listMeetingsFor(userId, { q }),
    // A convenience; a failure to read it must never take the list down.
    getResumableMeeting(userId).catch(() => null),
  ]);

  return (
    <PageShell width="default">
      <RenderStamp />
      <PageHeader
        title="Meetings"
        description="Every call you’ve recorded. Search by a person, a topic, or something that was said."
        actions={
          <Form action="/meetings" className="flex w-full gap-2 sm:w-auto" role="search">
            <div className="relative flex-1 sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                name="q"
                defaultValue={q}
                maxLength={100}
                placeholder="Search meetings — try “pricing” or a name"
                aria-label="Search meetings"
                className="pl-9"
              />
            </div>
            <Button type="submit" variant="outline">
              Search
            </Button>
            {q && (
              <Link href="/meetings" className={buttonVariants({ variant: "ghost" })}>
                Clear
              </Link>
            )}
          </Form>
        }
      />

      {unfinished && !q && (unfinished.status === "recording" || unfinished.status === "ended") && (
        <Link
          href="/capture?mode=meeting"
          className="flex items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm"
        >
          <span>
            <span className="font-medium text-foreground">
              Unfinished meeting{unfinished.title ? `: “${unfinished.title}”` : ""}
            </span>
            <span className="block text-muted-foreground">Pick it up or finish it in Capture.</span>
          </span>
          <span className="font-medium text-primary">Open →</span>
        </Link>
      )}

      <MeetingsList key={q} initial={page} q={q} />
    </PageShell>
  );
}
