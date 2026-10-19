import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import Link from "next/link";
import { PenLine, Plus, Users } from "lucide-react";
import {
  getRecruiterSharing,
  listDiscoverRecruiters,
  listMyRecruiters,
} from "@/actions/recruiters";
import { getGmailConnectionStatus, getGmailScanStatus } from "@/actions/gmail";
import { getOutlookConnectionStatus, getOutlookScanStatus } from "@/actions/outlook";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { RecruitersLocked } from "@/components/locked-feature";
import { PeopleListShell } from "@/components/contacts/people-list-shell";
import {
  RecruiterList,
  RecruiterSearch,
} from "@/components/recruiters/recruiter-list";
import { GmailImportPanel } from "@/components/recruiters/gmail-import-panel";
import { OutlookImportPanel } from "@/components/recruiters/outlook-import-panel";
import { RecruiterSharingToggle } from "@/components/recruiters/sharing-toggle";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { RenderStamp } from "@/components/layout/render-stamp";

export default async function RecruitersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tab?: string }>;
}) {
  const gate = await pageVisibilityGate("page.recruiters");
  if (gate) return gate;

  const params = await searchParams;
  const { canUseRecruiters } = await getEntitlements(await requireUserId());

  if (!canUseRecruiters) {
    return <RecruitersLocked />;
  }

  // "Discover" replaced the old "Directory" tab. Directory used to mean "every recruiter
  // anyone had ever logged"; under the sharing model a private user's directory is
  // identical to their own list, so the tab was showing the same rows twice.
  const tab = params.tab === "discover" ? "discover" : "mine";
  const q = params.q || "";

  const [{ enabled: sharing }, mine, gmail, scan, outlook, outlookScan, discover] = await Promise.all([
    getRecruiterSharing(),
    listMyRecruiters(),
    getGmailConnectionStatus(),
    // Seeds the panel so a scan already running on the server shows progress on load,
    // rather than looking idle until the first poll returns.
    getGmailScanStatus(),
    getOutlookConnectionStatus(),
    getOutlookScanStatus(),
    // Alongside the rest rather than after it: it depends on none of them. Returns [] for a
    // private viewer, so this is safe to call unconditionally.
    tab === "discover" ? listDiscoverRecruiters(q || undefined) : Promise.resolve([]),
  ]);

  const filteredMine =
    q && tab === "mine"
      ? mine.filter((r) => {
          const hay =
            `${r.fullName} ${r.firm || ""} ${r.specialty.join(" ")}`.toLowerCase();
          return hay.includes(q.toLowerCase());
        })
      : mine;

  const qs = q ? `?q=${encodeURIComponent(q)}` : "";

  return (
    <PeopleListShell
      active="recruiters"
      title="Recruiters"
      subtitle="Every recruiter you've talked to — and, if you share, the ones everyone else has."
      actions={
        <>
          {mine.length > 0 && (
            <Link href="/recruiters/compose" className={buttonVariants({ variant: "outline" })}>
              <PenLine className="size-4" />
              Compose
            </Link>
          )}
          <Link href="/recruiters/new" className={buttonVariants()}>
            <Plus className="size-4" />
            Add recruiter
          </Link>
        </>
      }
    >
      <RenderStamp />
      <div className="space-y-6">
        <RecruiterSharingToggle enabled={sharing} />
        <GmailImportPanel connection={gmail} initialScan={scan} />
        {/* The Outlook callback defaults to /imports (the contacts import lives there), so the
            scan panel says where it wants to land. */}
        <OutlookImportPanel connection={outlook} initialScan={outlookScan} returnTo="/recruiters" />

        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl
            ariaLabel="Recruiter lists"
            value={tab}
            items={[
              { key: "mine", label: "My recruiters", count: mine.length, href: `/recruiters${qs}` },
              { key: "discover", label: "Discover", href: `/recruiters?tab=discover${q ? `&q=${encodeURIComponent(q)}` : ""}` },
            ]}
          />
          <RecruiterSearch initialQ={q} className="min-w-[16rem] flex-1" />
        </div>

        {tab === "discover" && !sharing ? (
          // The empty Discover tab is the incentive made visible. Hiding it entirely
          // would also hide the offer, so it renders the reason instead of a list.
          <EmptyState
            variant="card"
            icon={Users}
            title="Nothing to discover yet"
            description="Discover shows recruiters other people have logged. It fills up when you share your own list — that’s the trade. Your notes and interaction summaries stay private either way."
          />
        ) : (
          <div className="rounded-xl border border-border-subtle bg-card">
            <RecruiterList
              recruiters={tab === "mine" ? filteredMine : discover}
              emptyMessage={
                tab === "mine"
                  ? q
                    ? "No recruiters match that search"
                    : "No recruiters yet"
                  : "No recruiters in the pool match yet"
              }
            />
          </div>
        )}
      </div>
    </PeopleListShell>
  );
}
