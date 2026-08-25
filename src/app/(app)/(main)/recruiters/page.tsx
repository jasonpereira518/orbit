import Link from "next/link";
import { PenLine, Plus } from "lucide-react";
import {
  getRecruiterSharing,
  listDiscoverRecruiters,
  listMyRecruiters,
} from "@/actions/recruiters";
import { getGmailConnectionStatus, getGmailScanStatus } from "@/actions/gmail";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { LockedFeature } from "@/components/locked-feature";
import { PeopleListShell } from "@/components/contacts/people-list-shell";
import {
  RecruiterList,
  RecruiterSearch,
} from "@/components/recruiters/recruiter-list";
import { GmailImportPanel } from "@/components/recruiters/gmail-import-panel";
import { RecruiterSharingToggle } from "@/components/recruiters/sharing-toggle";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default async function RecruitersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tab?: string }>;
}) {
  const params = await searchParams;
  const { canUseRecruiters } = await getEntitlements(await requireUserId());

  if (!canUseRecruiters) {
    return (
      <LockedFeature
        title="Recruiter tracking"
        description="A crowdsourced directory of recruiters, plus a record of every conversation you've had with each of them."
        highlights={[
          "Search recruiters by company and specialism",
          "Log interactions and unlock contact details",
          "Pull recruiter threads straight out of Gmail",
          "See who has gone quiet and who is worth a nudge",
        ]}
      />
    );
  }

  // "Discover" replaced the old "Directory" tab. Directory used to mean "every recruiter
  // anyone had ever logged"; under the sharing model a private user's directory is
  // identical to their own list, so the tab was showing the same rows twice.
  const tab = params.tab === "discover" ? "discover" : "mine";
  const q = params.q || "";

  const [{ enabled: sharing }, mine, gmail, scan] = await Promise.all([
    getRecruiterSharing(),
    listMyRecruiters(),
    getGmailConnectionStatus(),
    // Seeds the panel so a scan already running on the server shows progress on load,
    // rather than looking idle until the first poll returns.
    getGmailScanStatus(),
  ]);

  // Returns [] for a private viewer, so this is safe to call unconditionally.
  const discover =
    tab === "discover" ? await listDiscoverRecruiters(q || undefined) : [];

  const filteredMine =
    q && tab === "mine"
      ? mine.filter((r) => {
          const hay =
            `${r.fullName} ${r.firm || ""} ${r.specialty.join(" ")}`.toLowerCase();
          return hay.includes(q.toLowerCase());
        })
      : mine;

  return (
    <PeopleListShell
      active="recruiters"
      title="Recruiters"
      subtitle="Every recruiter you've talked to — and, if you share, the ones everyone else has."
      actions={
        <>
          {mine.length > 0 && (
            <Link
              href="/recruiters/compose"
              className={cn(buttonVariants({ variant: "outline" }))}
            >
              <PenLine className="mr-1 h-4 w-4" />
              Compose
            </Link>
          )}
        <Link
          href="/recruiters/new"
          className={cn(
            buttonVariants(),
            "bg-primary text-primary-foreground hover:bg-primary/90"
          )}
        >
          <Plus className="mr-1 h-4 w-4" />
          Log recruiter
        </Link>
        </>
      }
    >
      <div className="space-y-6">
        <RecruiterSharingToggle enabled={sharing} />
        <GmailImportPanel connection={gmail} initialScan={scan} />

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex rounded-lg border border-border/70 bg-card p-0.5 text-sm">
            <Link
              href={`/recruiters${q ? `?q=${encodeURIComponent(q)}` : ""}`}
              className={cn(
                "rounded-md px-3 py-1.5",
                tab === "mine"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              My recruiters ({mine.length})
            </Link>
            <Link
              href={`/recruiters?tab=discover${q ? `&q=${encodeURIComponent(q)}` : ""}`}
              className={cn(
                "rounded-md px-3 py-1.5",
                tab === "discover"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Discover
            </Link>
          </div>
          <RecruiterSearch initialQ={q} className="min-w-[16rem] flex-1" />
        </div>

        {tab === "discover" && !sharing ? (
          // The empty Discover tab is the incentive made visible. Hiding it entirely
          // would also hide the offer, so it renders the reason instead of a list.
          <div className="rounded-2xl border border-dashed border-border/70 bg-card px-5 py-12 text-center">
            <p className="font-medium text-primary">Nothing to discover yet</p>
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
              Discover shows recruiters other people have logged. It fills up
              when you share your own list — that&apos;s the trade. Your notes and
              interaction summaries stay private either way.
            </p>
          </div>
        ) : (
          <div className="rounded-2xl border border-border/70 bg-card">
            <RecruiterList
              recruiters={tab === "mine" ? filteredMine : discover}
              emptyMessage={
                tab === "mine"
                  ? q
                    ? "No recruiters match that search."
                    : "You haven’t logged any recruiters yet."
                  : "No recruiters in the pool match yet."
              }
            />
          </div>
        )}
      </div>
    </PeopleListShell>
  );
}
