import Link from "next/link";
import { notFound } from "next/navigation";
import { Lock, Mail, Phone, ExternalLink } from "lucide-react";
import { getRecruiter } from "@/actions/recruiters";
import { RecruiterLogForm } from "@/components/recruiters/recruiter-log-form";
import { RecruiterLinkEditor } from "@/components/recruiters/recruiter-link-editor";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function formatAvg(avgRating: number) {
  if (!avgRating) return "—";
  return (avgRating / 10).toFixed(1);
}

export default async function RecruiterDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const recruiter = await getRecruiter(id);
  if (!recruiter) notFound();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/recruiters"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← Recruiters
          </Link>
          <h1 className="mt-2 font-[family-name:var(--font-display)] text-3xl text-primary">
            {recruiter.fullName}
          </h1>
          <p className="mt-1 text-muted-foreground">
            {recruiter.firm || "Unknown firm"}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {recruiter.specialty.map((s) => (
              <Badge key={s} variant="secondary">
                {s}
              </Badge>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-border/70 bg-card px-4 py-3 text-center text-sm">
          <p className="text-2xl font-medium text-primary">
            ★ {formatAvg(recruiter.avgRating)}
          </p>
          <p className="text-xs text-muted-foreground">
            {recruiter.ratingCount} ratings · {recruiter.logCount} logs
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-border/70 bg-card p-5">
        <h2 className="font-[family-name:var(--font-display)] text-lg text-primary">
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
          <div className="mt-3 flex items-start gap-3 rounded-xl bg-muted/40 p-4 text-sm">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div>
              <p className="font-medium">Contact details are locked</p>
              <p className="mt-1 text-muted-foreground">
                Log that you&apos;ve interacted with (or plan to contact) this
                recruiter to unlock email, phone, and LinkedIn.
              </p>
            </div>
          </div>
        )}
      </div>

      {recruiter.myLink ? (
        <RecruiterLinkEditor
          recruiterId={recruiter.id}
          status={recruiter.myLink.status}
          notes={recruiter.myLink.notes}
          personalRating={recruiter.myLink.personalRating}
        />
      ) : (
        <div className="rounded-2xl border border-border/70 bg-card p-5">
          <h2 className="font-[family-name:var(--font-display)] text-lg text-primary">
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
