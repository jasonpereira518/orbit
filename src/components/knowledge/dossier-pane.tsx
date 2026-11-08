import { Suspense } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { listRelatedContacts } from "@/actions/contacts";
import { AiKeyNotice } from "@/components/ai-key-notice";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { DossierRefresh } from "@/components/knowledge/dossier-refresh";
import { DossierTimeline } from "@/components/knowledge/dossier-timeline";
import { TimelineSkeleton } from "@/components/knowledge/knowledge-skeletons";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { IntentLink } from "@/components/ui/intent-link";
import { getAiAccessStatus } from "@/lib/ai-access";
import { closenessTierChipClass } from "@/lib/closeness";
import { shouldAutoRefreshBrief } from "@/lib/contact-brief";
import { loadKnowledgeDossier } from "@/lib/knowledge-dossier";
import { loadKnowledgeTimeline } from "@/lib/knowledge-timeline";
import { requireUserForSurface } from "@/lib/plan-guards";
import { cn } from "@/lib/utils";

const TIER_LABEL = { inner: "Inner orbit", mid: "Mid orbit", outer: "Outer orbit" } as const;

/** True when one text already says what the other does, so the page doesn't print both. */
function sameThought(a: string, b: string) {
  const norm = (s: string) => s.toLowerCase().replace(/\W+/g, " ").trim();
  const x = norm(a);
  const y = norm(b);
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * One person, everything Orbit knows, read-only: a snapshot (who they are, where things
 * stand, how they fit your goals, the facts kept) with their history below it. Editing, notes and
 * reminders stay on the contact's own page (`Open profile`); this is the page you read to
 * understand someone.
 *
 * A server component that streams in behind the page's skeleton, with the history in its own
 * Suspense so the snapshot paints first. It does no writing and starts no model call itself:
 * a render like this also happens for a row that is only hovered, so a stale brief is handed
 * to `DossierRefresh`, which rebuilds it from the browser once the dossier is really open.
 */
export async function DossierPane({ contactId }: { contactId: string }) {
  const userId = await requireUserForSurface("page.knowledge");
  const [dossier, related, ai] = await Promise.all([
    loadKnowledgeDossier(userId, contactId).catch(() => null),
    listRelatedContacts(contactId, 6).catch(() => []),
    getAiAccessStatus(userId).catch(() => null),
  ]);

  if (!dossier) {
    return (
      <div className="space-y-4">
        <BackToPeople />
        <EmptyState
          title="We couldn’t find that person"
          description="They may have been merged into someone else or removed. Pick anyone from the list."
          className="rounded-2xl border border-dashed border-border/70 py-12"
        />
      </div>
    );
  }

  const { contact, brief, goals, facts } = dossier;
  const aiReady = ai?.ready ?? false;
  const name = contact.preferredName?.trim() || contact.fullName;
  const firstName = contact.firstName?.trim() || name;
  const role = [contact.title, contact.company].filter(Boolean).join(" at ");
  const auto = shouldAutoRefreshBrief({
    stale: dossier.stale,
    goalsUnjudged: dossier.goalsUnjudged,
    aiReady,
    modelWritten: dossier.brief?.model != null,
  });
  const goalFitPending = dossier.goalsUnjudged && aiReady;
  const tier = contact.closenessTier;
  const standing =
    brief?.standing && (!contact.aiSummary || !sameThought(brief.standing, contact.aiSummary))
      ? brief.standing
      : null;
  const hasFacts =
    Boolean(contact.howMet) ||
    contact.keyFacts.length > 0 ||
    Boolean(facts.career) ||
    Boolean(facts.recentMoves) ||
    Boolean(dossier.profileNotes) ||
    facts.tags.length > 0;

  return (
    <div className="space-y-5">
      <BackToPeople />

      <header className="flex flex-wrap items-start gap-4">
        <ContactAvatar
          contactId={contact.id}
          firstName={contact.firstName}
          fullName={contact.fullName}
          resolveOnDemand={contact.hasPhoto}
          size="lg"
        />
        <div className="min-w-[12rem] flex-1">
          {/* Below `lg` the page's own heading is hidden once someone is open, so the
              person's name is the page's h1 there and an h2 beside the page heading above. */}
          <h1 className="font-[family-name:var(--font-display)] text-2xl leading-tight text-ink lg:hidden">
            {contact.fullName}
          </h1>
          <h2 className="hidden font-[family-name:var(--font-display)] text-2xl leading-tight text-ink lg:block">
            {contact.fullName}
          </h2>
          {role ? <p className="mt-0.5 text-sm text-muted-foreground">{role}</p> : null}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {tier ? (
              <Badge variant="secondary" className={cn("text-xs", closenessTierChipClass(tier))}>
                {TIER_LABEL[tier]}
              </Badge>
            ) : null}
            {contact.location ? <span>{contact.location}</span> : null}
            {contact.lastInteractionAt ? (
              <span>
                Last in touch{" "}
                {formatDistanceToNowStrict(contact.lastInteractionAt, { addSuffix: true })}
              </span>
            ) : (
              <span>No conversations logged yet</span>
            )}
          </div>
        </div>
        <IntentLink
          href={`/contacts/${contact.id}`}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")}
        >
          Open profile <ArrowUpRight className="size-3.5" aria-hidden />
        </IntentLink>
      </header>

      {!aiReady ? <AiKeyNotice feature="knowledge" reason={ai?.reason ?? null} compact /> : null}

      {/* Snapshot: one surface, sections divided by hairlines instead of a card each. */}
      <div className="divide-y divide-border/50 rounded-2xl border border-border/60 bg-card/40">
        <section className="space-y-3 p-4" aria-labelledby="dossier-about">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <h3 id="dossier-about" className="text-sm font-medium text-ink">
              About {name}
            </h3>
            <DossierRefresh
              contactId={contact.id}
              updatedLabel={
                brief ? `Updated ${formatDistanceToNowStrict(brief.generatedAt, { addSuffix: true })}` : null
              }
              auto={auto}
            />
          </div>
          {contact.aiSummary ? (
            <p className="text-sm leading-relaxed text-ink">{contact.aiSummary}</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Orbit hasn’t written a summary for {name} yet. Log a note or an interaction and it will.
            </p>
          )}
          {standing ? (
            <p className="text-sm leading-relaxed text-foreground/90">{standing}</p>
          ) : null}
          {brief?.nextStep ? (
            <p className="text-sm text-foreground/90">
              <span className="font-medium text-ink">Next step: </span>
              {brief.nextStep}
            </p>
          ) : null}
        </section>

        <section className="space-y-3 p-4" aria-labelledby="dossier-fit">
          <h3 id="dossier-fit" className="text-sm font-medium text-ink">
            Fit with your goals
          </h3>
          {goals.activeCount === 0 ? (
            <p className="text-sm text-muted-foreground">
              You haven’t set a goal yet. Add one and Orbit will show who here can help with it.{" "}
              <IntentLink href="/settings" className="font-medium text-primary underline-offset-2 hover:underline">
                Add a goal
              </IntentLink>
            </p>
          ) : goals.fits.length > 0 ? (
            <ul className="space-y-3">
              {goals.fits.map((f) => (
                <li key={f.goalId}>
                  <p className="text-xs font-medium text-primary">{f.goalText}</p>
                  <p className="mt-0.5 text-sm leading-relaxed text-foreground/90">{f.why}</p>
                </li>
              ))}
            </ul>
          ) : goalFitPending ? (
            <p className="text-sm text-muted-foreground">Checking {name} against your goals…</p>
          ) : goals.judged ? (
            <p className="text-sm text-muted-foreground">
              Nothing about {name} maps to your goals yet. That can change as you learn more.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Goal fit is written by AI, so it needs a key. Everything else on this page works without one.
            </p>
          )}
        </section>

        <section className="space-y-4 p-4" aria-labelledby="dossier-facts">
          <h3 id="dossier-facts" className="text-sm font-medium text-ink">
            What Orbit knows
          </h3>
          {!hasFacts ? (
            <p className="text-sm text-muted-foreground">Nothing recorded about {name} yet beyond their name.</p>
          ) : null}

          {contact.howMet ? (
            <Fact label="How you met" source="From your notes">
              <p className="text-sm text-foreground/90">{contact.howMet}</p>
            </Fact>
          ) : null}

          {contact.keyFacts.length > 0 ? (
            <Fact label="Key facts" source="From your notes">
              <ul className="list-disc space-y-1 pl-4 text-sm text-foreground/90 marker:text-muted-foreground">
                {contact.keyFacts.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </Fact>
          ) : null}

          {facts.career || facts.recentMoves ? (
            <Fact label="Career" source="From LinkedIn">
              {facts.career ? <p className="text-sm text-foreground/90">{facts.career}</p> : null}
              {facts.recentMoves ? (
                <p className="mt-1 text-sm text-muted-foreground">Recently: {facts.recentMoves}</p>
              ) : null}
            </Fact>
          ) : null}

          {dossier.profileNotes ? (
            <Fact label="Your notes" source="From their profile">
              <p className="line-clamp-6 whitespace-pre-line text-sm text-foreground/90">
                {dossier.profileNotes}
              </p>
            </Fact>
          ) : null}

          {facts.tags.length > 0 ? (
            <Fact label="Tags" source="Yours">
              <div className="flex flex-wrap gap-1.5">
                {facts.tags.map((t) => (
                  <Badge key={t} variant="secondary" className="text-xs">
                    {t}
                  </Badge>
                ))}
              </div>
            </Fact>
          ) : null}
        </section>

        <section className="p-4" aria-labelledby="dossier-related">
          <h3 id="dossier-related" className="text-sm font-medium text-ink">
            Connected to
          </h3>
          {related.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              No one else in your orbit shares a company, school, event or note with {name} yet.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-border/50">
              {related.map((r) => (
                <li key={r.id}>
                  <IntentLink
                    href={`/knowledge?p=${r.id}`}
                    className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-muted/40"
                  >
                    <ContactAvatar
                      contactId={r.id}
                      firstName={r.firstName}
                      fullName={r.fullName}
                      profileImageUrl={null}
                      size="sm"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink">{r.fullName}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {[r.title, r.company].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {r.reasonLabel}
                    </span>
                  </IntentLink>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section aria-labelledby="dossier-history">
        <h3 id="dossier-history" className="mb-3 text-sm font-medium text-ink">
          History
        </h3>
        <Suspense fallback={<TimelineSkeleton />}>
          <Timeline userId={userId} contactId={contact.id} name={firstName} />
        </Suspense>
      </section>
    </div>
  );
}

/** The history, read on its own so the snapshot above it does not wait for it. */
async function Timeline({ userId, contactId, name }: { userId: string; contactId: string; name: string }) {
  const timeline = await loadKnowledgeTimeline(userId, contactId);
  return <DossierTimeline items={timeline.items} truncated={timeline.truncated} name={name} />;
}

/** Below `lg` the list and the dossier are two screens, and this is the way back. */
function BackToPeople() {
  return (
    <IntentLink
      href="/knowledge"
      className="inline-flex min-h-9 items-center gap-1.5 text-sm font-medium text-foreground hover:text-primary lg:hidden"
    >
      <ArrowLeft className="size-4" aria-hidden /> All people
    </IntentLink>
  );
}

function Fact({
  label,
  source,
  children,
}: {
  label: string;
  source: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h4 className="text-xs font-medium text-muted-foreground">{label}</h4>
        <span className="text-xs text-muted-foreground-subtle">{source}</span>
      </div>
      {children}
    </div>
  );
}
