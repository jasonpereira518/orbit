import Form from "next/form";
import Link from "next/link";
import { Search } from "lucide-react";
import { LockedFeature } from "@/components/locked-feature";
import { MeetingsList } from "@/components/meetings/meetings-list";
import { RenderStamp } from "@/components/layout/render-stamp";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireUserId } from "@/lib/auth";
import { FEATURE_DENIAL, getEntitlements } from "@/lib/entitlements";
import { getResumableMeeting } from "@/lib/meeting-sessions";
import { listMeetingsFor } from "@/lib/meetings-list";

export default async function MeetingsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q: rawQ } = await searchParams;
  const q = (rawQ ?? "").trim().slice(0, 100);
  const userId = await requireUserId();
  const { canUseMeetings } = await getEntitlements(userId);

  if (!canUseMeetings) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <RenderStamp />
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">Meetings</h1>
        <LockedFeature
          title="Meeting history"
          description={FEATURE_DENIAL.meetings}
          highlights={[
            "Every call you recorded, kept and searchable",
            "Search by person, topic or what was said",
            "Ask Chat what came up in a meeting",
          ]}
        />
      </div>
    );
  }

  const [page, unfinished] = await Promise.all([
    listMeetingsFor(userId, { q }),
    // A convenience; a failure to read it must never take the list down.
    getResumableMeeting(userId).catch(() => null),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <RenderStamp />
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">Meetings</h1>
        <p className="mt-1 text-muted-foreground">
          Every call you&apos;ve recorded. Search by a person, a topic, or something that was said.
        </p>
      </div>

      <Form action="/meetings" className="flex gap-2" role="search">
        <div className="relative flex-1">
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
        <Button type="submit">Search</Button>
        {q && (
          <Link href="/meetings" className="inline-flex items-center px-2 text-sm text-muted-foreground hover:text-foreground">
            Clear
          </Link>
        )}
      </Form>

      {unfinished && !q && (unfinished.status === "recording" || unfinished.status === "ended") && (
        <Link
          href="/capture?mode=meeting"
          className="flex items-center justify-between gap-3 rounded-2xl border border-primary/30 bg-primary/[0.04] p-4 text-sm"
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
    </div>
  );
}
