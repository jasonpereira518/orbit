import { format, formatDistanceToNowStrict } from "date-fns";
import { ArrowLeft, ArrowUpRight, Calendar, Sparkles, Target, Users } from "lucide-react";
import { listRelatedContacts } from "@/actions/contacts";
import { AiKeyNotice } from "@/components/ai-key-notice";
import { ContactAvatar } from "@/components/contacts/contact-avatar";
import { DossierRefresh } from "@/components/knowledge/dossier-refresh";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { IntentLink } from "@/components/ui/intent-link";
import { getAiAccessStatus } from "@/lib/ai-access";
import { closenessTierChipClass } from "@/lib/closeness";
import { loadKnowledgeDossier } from "@/lib/knowledge-dossier";
import { requireUserForSurface } from "@/lib/plan-guards";
import { cn } from "@/lib/utils";

const TIER_LABEL = { inner: "Inner orbit", mid: "Mid orbit", outer: "Outer orbit" } as const;

/**
 * One person, everything Orbit knows, read-only. Editing, notes and reminders stay on the
 * contact's own page (`Open profile`); this is the page you read to understand someone.
 *
 * A server component that streams in behind the page's skeleton. It does no writing and
 * starts no model call itself: a render like this also happens for a row that is only
 * hovered, so a stale brief is handed to `DossierRefresh`, which rebuilds it from the
 * browser once the dossier is really open.
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
        <div className="rounded-2xl border border-dashed border-border/70 px-6 py-12 text-center">
          <h2 className="font-[family-name:var(--font-display)] text-xl text-ink">
            We couldn’t find that person
          </h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
            They may have been merged into someone else or removed. Pick anyone from the list.
          </p>
        </div>
      </div>
    );
  }

  const { contact, brief, goals, facts } = dossier;
  const aiReady = ai?.ready ?? false;
  const name = contact.preferredName?.trim() || contact.fullName;
  const role = [contact.title, contact.company].filter(Boolean).join(" at ");
  // Rebuilding helps a stale brief with or without a key (there is a deterministic fallback);
  // it only helps goal fit when a model can actually run, or this would be true forever.
  const auto = dossier.stale || (dossier.goalsUnjudged && aiReady);
  const goalFitPending = dossier.goalsUnjudged && aiReady;
  const tier = contact.closenessTier;
  const hasFacts =
    Boolean(contact.howMet) ||
    contact.keyFacts.length > 0 ||
    Boolean(facts.career) ||
    Boolean(facts.recentMoves) ||
    Boolean(brief?.recentDiscussions.length) ||
    facts.events.length > 0 ||
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
          <h2 className="font-[family-name:var(--font-display)] text-2xl leading-tight text-ink">
            {contact.fullName}
          </h2>
          {role ? <p className="mt-0.5 text-sm text-muted-foreground">{role}</p> : null}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {tier ? (
              <Badge variant="secondary" className={cn("text-[10px]", closenessTierChipClass(tier))}>
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

      <Card className="border-border/70 shadow-none">
        <CardHeader className="flex-row items-center justify-between gap-3 border-b border-border/50">
          <CardTitle as="h3" className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" aria-hidden /> About {name}
          </CardTitle>
          <DossierRefresh
            contactId={contact.id}
            updatedLabel={
              brief ? `Updated ${formatDistanceToNowStrict(brief.generatedAt, { addSuffix: true })}` : null
            }
            auto={auto}
          />
        </CardHeader>
        <CardContent className="space-y-4">
          {contact.aiSummary ? (
            <p className="text-sm leading-relaxed text-ink">{contact.aiSummary}</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Orbit hasn’t written a summary for {name} yet. Log a note or an interaction and it
              will.
            </p>
          )}
          {brief?.standing && brief.standing !== contact.aiSummary ? (
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Where things stand
              </p>
              <p className="mt-1 text-sm leading-relaxed text-foreground/90">{brief.standing}</p>
            </div>
          ) : null}
          {brief?.nextStep ? (
            <p className="rounded-xl bg-accent px-3 py-2 text-sm text-accent-foreground">
              <span className="font-medium">Next: </span>
              {brief.nextStep}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card className="border-border/70 shadow-none">
        <CardHeader className="border-b border-border/50">
          <CardTitle as="h3" className="flex items-center gap-2">
            <Target className="size-4 text-primary" aria-hidden /> Fit with your goals
          </CardTitle>
        </CardHeader>
        <CardContent>
          {goals.activeCount === 0 ? (
            <p className="text-sm text-muted-foreground">
              You haven’t set a goal yet. Add one and Orbit will show who here can help with it.{" "}
              <IntentLink
                href="/settings"
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                Add a goal
              </IntentLink>
            </p>
          ) : goals.fits.length > 0 ? (
            <ul className="space-y-3">
              {goals.fits.map((f) => (
                <li key={f.goalId} className="rounded-xl border border-border/60 px-3.5 py-3">
                  <p className="text-xs font-medium text-primary">{f.goalText}</p>
                  <p className="mt-1 text-sm leading-relaxed text-foreground/90">{f.why}</p>
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
              Goal fit is written by AI, so it needs a key. Everything else on this page works
              without one.
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/70 shadow-none">
        <CardHeader className="border-b border-border/50">
          <CardTitle as="h3" className="flex items-center gap-2">
            <Users className="size-4 text-primary" aria-hidden /> Connected to
          </CardTitle>
        </CardHeader>
        <CardContent>
          {related.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              No one else in your orbit shares a company, school, event or note with {name} yet.
            </p>
          ) : (
            <ul className="divide-y divide-border/50">
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
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                      {r.reasonLabel}
                    </span>
                  </IntentLink>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/70 shadow-none">
        <CardHeader className="border-b border-border/50">
          <CardTitle as="h3">What Orbit knows</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {!hasFacts ? (
            <p className="text-sm text-muted-foreground">
              Nothing recorded about {name} yet beyond their name.
            </p>
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

          {brief && brief.recentDiscussions.length > 0 ? (
            <Fact label="Recent conversations" source="From your interactions">
              <ul className="space-y-1.5">
                {brief.recentDiscussions.map((d) => (
                  <li key={d.interactionId} className="flex gap-3 text-sm">
                    <time
                      dateTime={d.dateIso}
                      className="w-24 shrink-0 text-xs tabular-nums text-muted-foreground"
                    >
                      {format(new Date(`${d.dateIso}T12:00:00`), "MMM d, yyyy")}
                    </time>
                    <span className="text-foreground/90">{d.line}</span>
                  </li>
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

          {facts.events.length > 0 ? (
            <Fact label="Events together" source="From your events">
              <ul className="space-y-1">
                {facts.events.map((e) => (
                  <li key={e.eventId} className="flex items-center gap-2 text-sm text-foreground/90">
                    <Calendar className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 truncate">{e.title}</span>
                    {e.startsAt ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {format(new Date(e.startsAt), "MMM yyyy")}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Fact>
          ) : null}

          {facts.tags.length > 0 ? (
            <Fact label="Tags" source="Yours">
              <div className="flex flex-wrap gap-1.5">
                {facts.tags.map((t) => (
                  <Badge key={t} variant="secondary" className="text-[11px]">
                    {t}
                  </Badge>
                ))}
              </div>
            </Fact>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

/** Below `lg` the list and the dossier are two screens, and this is the way back. */
function BackToPeople() {
  return (
    <IntentLink
      href="/knowledge"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground lg:hidden"
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
    <section>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <h4 className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</h4>
        <span className="text-[11px] text-muted-foreground/80">{source}</span>
      </div>
      {children}
    </section>
  );
}
