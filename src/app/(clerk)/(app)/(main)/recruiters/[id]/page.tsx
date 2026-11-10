import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import Link from "next/link";
import type { Metadata } from "next";
import { cache } from "react";
import { notFound } from "next/navigation";
import { Lock, Mail, Phone, ExternalLink } from "lucide-react";
import { getRecruiter, getRecruiterSharing } from "@/actions/recruiters";
import { RecruiterLogForm } from "@/components/recruiters/recruiter-log-form";
import { RecruiterUnlockButton } from "@/components/recruiters/recruiter-unlock-button";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { RecruitersLocked } from "@/components/locked-feature";
import { getEffectivePlanConfig } from "@/lib/plans/plan-rules";
import { RecruiterLinkEditor } from "@/components/recruiters/recruiter-link-editor";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RenderStamp } from "@/components/layout/render-stamp";

/** Request-memoized so `generateMetadata` and the page share one read. */
const loadRecruiter = cache((id: string) => getRecruiter(id));

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const recruiter = await loadRecruiter(id).catch(() => null);
  return { title: recruiter?.fullName || "Recruiter" };
}

function formatAvg(avgRating: number) {
  if (!avgRating) return "—";
  return (avgRating / 10).toFixed(1);
}

export default async function RecruiterDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const gate = await pageVisibilityGate("page.recruiters");
  if (gate) return gate;

  const { id } = await params;
  const { canUseRecruiters } = await getEntitlements(await requireUserId());
  if (!canUseRecruiters) return <RecruitersLocked config={await getEffectivePlanConfig()} />;

  const [recruiter, { enabled: sharingEnabled }] = await Promise.all([
    loadRecruiter(id),
    getRecruiterSharing(),
  ]);
  if (!recruiter) notFound();

  const link = recruiter.myLink;
  const summary = link?.aiSummary?.trim();
  const companies = link?.companiesMentioned ?? [];
  const roles = link?.rolesDiscussed ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <RenderStamp />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/recruiters"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← Recruiters
          </Link>
          <h1 className="mt-2 font-[family-name:var(--font-display)] text-3xl text-ink">
            {recruiter.fullName}
          </h1>
          <p className="mt-1 text-muted-foreground">
            {recruiter.firm || "Unknown firm"}
          </p>
          {recruiter.role && (
            <p className="mt-1 text-sm font-medium text-foreground">
              Interviewing for: <span className="text-primary">{recruiter.role}</span>
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {recruiter.specialty.map((s) => (
              <Badge key={s} variant="secondary">
                {s}
              </Badge>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-border/70 bg-card px-4 py-3 text-center text-sm">
          {recruiter.ratingCount > 0 ? (
            <>
              <p className="text-2xl font-medium text-ink">
                ★ {formatAvg(recruiter.avgRating)}
              </p>
              <p className="text-xs text-muted-foreground">
                {recruiter.ratingCount} ratings · {recruiter.logCount} logs
              </p>
            </>
          ) : (
            <>
              {/* Aggregates only count links shared into the pool, so this is the
                  normal state for a recruiter nobody else has shared — not an error. */}
              <p className="text-sm font-medium text-muted-foreground">
                No community ratings
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {link?.personalRating
                  ? `You rated them ${link.personalRating}/5`
                  : "Nobody has shared a rating yet"}
              </p>
            </>
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-border/70 bg-card p-5">
        <h2 className="font-[family-name:var(--font-display)] text-lg text-ink">
          Contact
        </h2>
        {recruiter.piiUnlocked ? (
          <ul className="mt-3 space-y-2 text-sm">
            {recruiter.email && (
              <li className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <a
                  href={`mailto:${recruiter.email}`}
                  className="hover:underline"
                >
                  {recruiter.email}
                </a>
              </li>
            )}
            {recruiter.phone && (
              <li className="flex items-center gap-2">
                <Phone className="h-4 w-4 text-muted-foreground" />
                {recruiter.phone}
              </li>
            )}
            {recruiter.linkedinUrl && (
              <li className="flex items-center gap-2">
                <ExternalLink className="h-4 w-4 text-muted-foreground" />
                <a
                  href={recruiter.linkedinUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline"
                >
                  LinkedIn
                </a>
              </li>
            )}
            {!recruiter.email &&
              !recruiter.phone &&
              !recruiter.linkedinUrl && (
                <li className="text-muted-foreground">
                  No contact details contributed yet.
                </li>
              )}
          </ul>
        ) : (
          <div className="mt-3">
            <RecruiterUnlockButton
              recruiterId={recruiter.id}
              hasEmail={recruiter.hasEmail}
              hasLinkedin={recruiter.hasLinkedin}
            />
          </div>
        )}
      </div>

      {(summary || companies.length > 0 || roles.length > 0) && (
        <div className="rounded-2xl border border-border/70 bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-[family-name:var(--font-display)] text-lg text-ink">
              Your history
            </h2>
            {/* Stated plainly because this text is distilled from the user's inbox.
                It lives on the link, never on the shared recruiter row. */}
            <Badge variant="outline" className="text-3xs">
              Private to you
            </Badge>
          </div>
          {summary && (
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              {summary}
            </p>
          )}
          {companies.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Companies
              </p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {companies.map((c) => (
                  <Badge key={c} variant="secondary">
                    {c}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {roles.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Roles discussed
              </p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {roles.map((r) => (
                  <Badge key={r} variant="secondary">
                    {r}
                  </Badge>
                ))}
              </div>
            </div>
          )}
          {link?.emailCount ? (
            <p className="mt-4 text-xs text-muted-foreground">
              {link.emailCount} email{link.emailCount === 1 ? "" : "s"}
              {link.lastEmailAt
                ? ` · last on ${new Date(link.lastEmailAt).toLocaleDateString()}`
                : ""}
            </p>
          ) : null}
        </div>
      )}

      {link ? (
        <RecruiterLinkEditor
          recruiterId={recruiter.id}
          status={link.status}
          notes={link.notes}
          personalRating={link.personalRating}
          sharedToPool={link.sharedToPool === 1}
          sharingEnabled={sharingEnabled}
        />
      ) : (
        <div className="rounded-2xl border border-border/70 bg-card p-5">
          <h2 className="font-[family-name:var(--font-display)] text-lg text-ink">
            Log your interaction
          </h2>
          <p className="mt-1 mb-4 text-sm text-muted-foreground">
            This unlocks contact details and contributes to community rankings.
          </p>
          <RecruiterLogForm
            recruiterId={recruiter.id}
            initial={{
              fullName: recruiter.fullName,
              firm: recruiter.firm || undefined,
              specialty: recruiter.specialty.join(", "),
            }}
          />
        </div>
      )}

      <Link
        href="/recruiters/new"
        className={cn(buttonVariants({ variant: "outline" }))}
      >
        Log a different recruiter
      </Link>
    </div>
  );
}
