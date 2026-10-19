import { pageVisibilityGate } from "@/components/coming-soon/page-gate";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Lock, Mail, Phone, ExternalLink, Star } from "lucide-react";
import { getRecruiter, getRecruiterSharing } from "@/actions/recruiters";
import { RecruiterLogForm } from "@/components/recruiters/recruiter-log-form";
import { requireUserId } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { RecruitersLocked } from "@/components/locked-feature";
import { RecruiterLinkEditor } from "@/components/recruiters/recruiter-link-editor";
import { PageHeader } from "@/components/layout/page-header";
import { PageShell } from "@/components/layout/page-shell";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RenderStamp } from "@/components/layout/render-stamp";

const EYEBROW = "text-xs font-medium uppercase tracking-wider text-muted-foreground";

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
  if (!canUseRecruiters) return <RecruitersLocked />;

  const [recruiter, { enabled: sharingEnabled }] = await Promise.all([
    getRecruiter(id),
    getRecruiterSharing(),
  ]);
  if (!recruiter) notFound();

  const link = recruiter.myLink;
  const summary = link?.aiSummary?.trim();
  const companies = link?.companiesMentioned ?? [];
  const roles = link?.rolesDiscussed ?? [];

  return (
    <PageShell width="default">
      <RenderStamp />
      <PageHeader
        back={{ href: "/recruiters", label: "Back to recruiters" }}
        title={recruiter.fullName}
        description={
          <>
            {recruiter.firm || "Unknown firm"}
            {recruiter.specialty.length > 0 && (
              // Spans, not divs: this sits inside the header's description paragraph.
              <span className="mt-2 flex flex-wrap gap-2">
                {recruiter.specialty.map((s) => (
                  <Badge key={s} variant="secondary">
                    {s}
                  </Badge>
                ))}
              </span>
            )}
          </>
        }
        actions={
          <Card size="sm" className="text-center">
            <CardContent>
              {recruiter.ratingCount > 0 ? (
                <>
                  <p className="flex items-center justify-center gap-1 text-2xl font-medium text-ink">
                    <Star className="size-5 fill-current" aria-hidden />
                    {formatAvg(recruiter.avgRating)}
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
            </CardContent>
          </Card>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle as="h2">Contact</CardTitle>
        </CardHeader>
        <CardContent>
          {recruiter.piiUnlocked ? (
            <ul className="space-y-2 text-sm">
              {recruiter.email && (
                <li className="flex items-center gap-2">
                  <Mail className="size-4 text-muted-foreground" aria-hidden />
                  <a href={`mailto:${recruiter.email}`} className="hover:underline">
                    {recruiter.email}
                  </a>
                </li>
              )}
              {recruiter.phone && (
                <li className="flex items-center gap-2">
                  <Phone className="size-4 text-muted-foreground" aria-hidden />
                  {recruiter.phone}
                </li>
              )}
              {recruiter.linkedinUrl && (
                <li className="flex items-center gap-2">
                  <ExternalLink className="size-4 text-muted-foreground" aria-hidden />
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
              {!recruiter.email && !recruiter.phone && !recruiter.linkedinUrl && (
                <li className="text-muted-foreground">No contact details contributed yet.</li>
              )}
            </ul>
          ) : (
            <div className="flex items-start gap-3 rounded-lg border border-border-subtle bg-surface-inset p-4 text-sm">
              <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div>
                <p className="font-medium text-ink">Contact details are locked</p>
                <p className="mt-1 text-muted-foreground">
                  Log that you’ve interacted with (or plan to contact) this recruiter to
                  unlock email, phone, and LinkedIn.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {(summary || companies.length > 0 || roles.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle as="h2">Your history</CardTitle>
            {/* Stated plainly because this text is distilled from the user's inbox.
                It lives on the link, never on the shared recruiter row. */}
            <CardAction>
              <Badge variant="outline" size="sm">
                Private to you
              </Badge>
            </CardAction>
            {summary && (
              <CardDescription className="leading-relaxed">{summary}</CardDescription>
            )}
          </CardHeader>
          {(companies.length > 0 || roles.length > 0 || link?.emailCount) && (
            <CardContent className="space-y-4">
              {companies.length > 0 && (
                <div>
                  <p className={EYEBROW}>Companies</p>
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
                <div>
                  <p className={EYEBROW}>Roles discussed</p>
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
                <p className="text-xs text-muted-foreground">
                  {link.emailCount} email{link.emailCount === 1 ? "" : "s"}
                  {link.lastEmailAt
                    ? ` · last on ${new Date(link.lastEmailAt).toLocaleDateString()}`
                    : ""}
                </p>
              ) : null}
            </CardContent>
          )}
        </Card>
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
        <Card>
          <CardHeader>
            <CardTitle as="h2">Log your interaction</CardTitle>
            <CardDescription>
              This unlocks contact details and contributes to community rankings.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RecruiterLogForm
              recruiterId={recruiter.id}
              initial={{
                fullName: recruiter.fullName,
                firm: recruiter.firm || undefined,
                specialty: recruiter.specialty.join(", "),
              }}
            />
          </CardContent>
        </Card>
      )}

      <Link href="/recruiters/new" className={buttonVariants({ variant: "outline" })}>
        Add a different recruiter
      </Link>
    </PageShell>
  );
}
