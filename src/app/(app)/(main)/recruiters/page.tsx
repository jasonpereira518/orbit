import Link from "next/link";
import { Plus } from "lucide-react";
import {
  listMyRecruiters,
  searchRecruiters,
} from "@/actions/recruiters";
import { getGmailConnectionStatus } from "@/actions/gmail";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { LockedFeature } from "@/components/locked-feature";
import { PeopleListShell } from "@/components/contacts/people-list-shell";
import {
  RecruiterList,
  RecruiterSearch,
} from "@/components/recruiters/recruiter-list";
import { GmailImportPanel } from "@/components/recruiters/gmail-import-panel";
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
        note="Included in Orbit Pro and Orbit Lifetime."
      />
    );
  }

  const tab = params.tab === "mine" ? "mine" : "directory";
  const q = params.q || "";

  const [directory, mine, gmail] = await Promise.all([
    searchRecruiters(q || undefined),
    listMyRecruiters(),
    getGmailConnectionStatus(),
  ]);

  const list = tab === "mine" ? mine : directory;

  return (
    <PeopleListShell
      active="recruiters"
      title="Recruiters"
      subtitle="Crowdsourced directory — contact details unlock when you log an interaction."
      actions={
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
      }
    >
      <div className="space-y-6">
        <GmailImportPanel connection={gmail} />

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex rounded-lg border border-border/70 bg-card p-0.5 text-sm">
            <Link
              href={`/recruiters${q ? `?q=${encodeURIComponent(q)}` : ""}`}
              className={cn(
                "rounded-md px-3 py-1.5",
                tab === "directory"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Directory
            </Link>
            <Link
              href={`/recruiters?tab=mine${q ? `&q=${encodeURIComponent(q)}` : ""}`}
              className={cn(
                "rounded-md px-3 py-1.5",
                tab === "mine"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              My recruiters ({mine.length})
            </Link>
          </div>
          {tab === "directory" && (
            <RecruiterSearch initialQ={q} className="min-w-[16rem] flex-1" />
          )}
        </div>

        <div className="rounded-2xl border border-border/70 bg-card">
          <RecruiterList
            recruiters={
              tab === "mine" && q
                ? list.filter((r) => {
                    const hay =
                      `${r.fullName} ${r.firm || ""} ${r.specialty.join(" ")}`.toLowerCase();
                    return hay.includes(q.toLowerCase());
                  })
                : list
            }
            emptyMessage={
              tab === "mine"
                ? "You haven’t logged any recruiters yet."
                : "No recruiters match. Be the first to log one."
            }
          />
        </div>
      </div>
    </PeopleListShell>
  );
}
