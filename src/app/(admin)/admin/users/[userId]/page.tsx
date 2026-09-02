import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft, CircleAlert } from "lucide-react";
import {
  AdminPanel,
  AdminTable,
  DefinitionRow,
  EmptyState,
  PlanBadge,
  RelativeTime,
  SecretState,
  Td,
  Th,
} from "@/components/admin/primitives";
import { CompPlanButton } from "@/components/admin/comp-plan-dialog";
import { SignInLinkButton } from "@/components/admin/sign-in-link-dialog";
import { CopyId } from "@/components/admin/copy-id";
import { ContactsFilterBar } from "@/components/admin/contacts-filter-bar";
import { AccountDangerZone } from "@/components/admin/account-actions";
import { Pager } from "@/components/admin/pager";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { getAuditTrail } from "@/actions/admin";
import { requireAdminUserId } from "@/lib/admin";
import { displayName, fullName, initialsFor } from "@/lib/admin-metrics";
import { recordAccountView } from "@/lib/admin-operations";
import {
  ADMIN_CONTACTS_PAGE_SIZE,
  getAdminUserDetail,
  listAdminContacts,
} from "@/lib/admin-user-detail";
import { loadAdminTimeline } from "@/lib/admin-timeline";
import { formatCostMicros } from "@/lib/ai-pricing";
import { cn } from "@/lib/utils";

export const metadata = { title: "Admin · Account" };

const SECTIONS = [
  { id: "identity", label: "Identity" },
  { id: "plan", label: "Plan & billing" },
  { id: "health", label: "Health" },
  { id: "footprint", label: "Footprint" },
  { id: "usage", label: "AI usage" },
  { id: "config", label: "Configuration" },
  { id: "timeline", label: "Timeline" },
  { id: "contacts", label: "Contacts" },
  { id: "audit", label: "Audit trail" },
  { id: "actions", label: "Danger zone" },
];

/**
 * One scrolling page with a sticky section rail — deliberately not tabs.
 *
 * The repo already solved this in `src/components/settings/sections.ts` +
 * `settings-section-nav.tsx`. The rail wins on every axis that matters here: sections are
 * deep-linkable (`#plan` pastes into a note), the back button behaves, and there is no
 * client tab state to desync — and no new `ui/tabs.tsx` primitive for a single consumer.
 */
export default async function AdminUserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<{
    contactsPage?: string;
    contactsQ?: string;
    before?: string;
  }>;
}) {
  const { userId } = await params;
  const query = await searchParams;
  const decoded = decodeURIComponent(userId);

  const adminUserId = await requireAdminUserId();

  const detail = await getAdminUserDetail(decoded);
  if (!detail) notFound();

  // Opening an account is itself a recorded act. This is what remains of the reveal gate:
  // the operator no longer justifies a look, but the look is still on the record. Throttled
  // to one row an hour inside `recordAccountView`, and it never throws.
  await recordAccountView(adminUserId, decoded);

  const contactsPage = Math.max(
    Number.parseInt(query.contactsPage ?? "1", 10) || 1,
    1
  );
  const contactsQ = query.contactsQ?.trim() ?? "";
  const before = query.before ? new Date(query.before) : null;

  const [audit, contactPage, timeline] = await Promise.all([
    getAuditTrail(decoded).catch(() => []),
    listAdminContacts(decoded, {
      page: contactsPage,
      pageSize: ADMIN_CONTACTS_PAGE_SIZE,
      search: contactsQ,
    }),
    loadAdminTimeline(decoded, {
      before: before && !Number.isNaN(before.getTime()) ? before : null,
    }),
  ]);

  const { identity, billing, configuration, footprint, health, usage } = detail;
  const name = fullName(identity);

  const ent = billing.entitlements;
  const entitlementFlags: Array<[string, boolean]> = [
    ["outreach", ent.canUseOutreach],
    ["hosted sending", ent.canUseHostedSending],
    ["hosted enrichment", ent.canUseHostedEnrichment],
    ["recruiters", ent.canUseRecruiters],
    ["sync", ent.canUseSync],
    ["extension", ent.canUseExtension],
  ];

  return (
    <>
      <Link
        href="/admin/users"
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
      >
        <ArrowLeft className="size-3" aria-hidden /> All users
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          {/* Clerk's CDN host is not in `images.remotePatterns`, so this is a plain <img>
              via the Avatar primitive rather than next/image. The fallback carries the
              weight for every account that predates the identity mirror. */}
          <Avatar size="lg" className="shrink-0">
            {identity.imageUrl && (
              <AvatarImage
                src={identity.imageUrl}
                alt=""
                referrerPolicy="no-referrer"
              />
            )}
            <AvatarFallback>{initialsFor(identity)}</AvatarFallback>
          </Avatar>

          <div className="min-w-0">
            <h1 className="truncate font-[family-name:var(--font-display)] text-2xl text-ink">
              {displayName(identity)}
            </h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {/* Only when the title is already the name — otherwise this repeats it. */}
              {name && identity.email && <span>{identity.email}</span>}
              <CopyId value={identity.userId} />
              {identity.suspendedAt && (
                <span className="rounded-md bg-destructive/10 px-1.5 py-0.5 text-destructive">
                  suspended
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <SignInLinkButton
            targetUserId={identity.userId}
            email={identity.email}
          />
          <CompPlanButton
            targetUserId={identity.userId}
            email={identity.email}
            currentPlan={billing.plan}
            currentSource={billing.source}
            contactCount={footprint.contacts}
            compedNote={billing.compedNote}
            variant="button"
          />
        </div>
      </div>

      <div className="flex gap-8">
        <nav
          aria-label="Sections"
          className="sticky top-20 hidden h-fit w-40 shrink-0 lg:block"
        >
          <ul className="space-y-0.5 text-sm">
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="block rounded-md px-2 py-1 text-muted-foreground transition-colors duration-fast hover:bg-muted hover:text-foreground"
                >
                  {section.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 flex-1 space-y-6">
          <section id="identity" className="scroll-mt-20">
            <AdminPanel title="Identity">
              <dl>
                <DefinitionRow label="Email">
                  {identity.email ?? "—"}
                </DefinitionRow>
                <DefinitionRow label="User id">
                  <span className="font-mono text-xs">{identity.userId}</span>
                </DefinitionRow>
                <DefinitionRow label="Signed up">
                  <RelativeTime date={identity.signupAt} /> ago
                </DefinitionRow>
                <DefinitionRow label="Last seen">
                  {identity.lastActiveAt ? (
                    <>
                      <RelativeTime date={identity.lastActiveAt} /> ago
                    </>
                  ) : footprint.lastWriteAt ? (
                    <>
                      <RelativeTime date={footprint.lastWriteAt} /> ago{" "}
                      <span className="text-xs text-muted-foreground">
                        (last write)
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">never</span>
                  )}
                </DefinitionRow>
                <DefinitionRow label="Onboarding">
                  {identity.onboardingCompletedAt ? (
                    <>
                      done <RelativeTime date={identity.onboardingCompletedAt} /> ago
                    </>
                  ) : footprint.contacts > 0 || footprint.imports > 0 ? (
                    <span className="text-muted-foreground">
                      implicit (has data, flag not set)
                    </span>
                  ) : (
                    <span className="text-destructive">
                      not started{identity.onboardingStep ? ` · ${identity.onboardingStep}` : ""}
                    </span>
                  )}
                </DefinitionRow>
                <DefinitionRow label="Wizard">
                  {identity.wizardCompletedAt ? (
                    <>
                      done <RelativeTime date={identity.wizardCompletedAt} /> ago
                    </>
                  ) : (
                    <span className="text-muted-foreground">not completed</span>
                  )}
                </DefinitionRow>
              </dl>
            </AdminPanel>
          </section>

          <section id="plan" className="scroll-mt-20">
            <AdminPanel title="Plan & billing">
              {/*
                Resolved plan first, then the raw inputs beneath it. Precedence
                (comp > lifetime > subscription > free) is invisible unless all four inputs
                are visible at once — and entitlement bugs are the ones that generate
                angry emails.
              */}
              <div className="mb-3 flex items-center gap-3 border-b border-border/60 pb-3">
                <PlanBadge plan={billing.plan} source={billing.source} />
                {billing.source === "comp" && (
                  <span className="text-xs text-muted-foreground">
                    comp overrides everything below
                  </span>
                )}
              </div>

              <dl>
                <DefinitionRow label="comped_plan">
                  {billing.compedPlan ? (
                    <span className="text-accent-foreground">
                      {billing.compedPlan}
                      {billing.compedAt && (
                        <>
                          {" "}
                          · set <RelativeTime date={billing.compedAt} /> ago
                        </>
                      )}
                      {billing.compedNote && (
                        <span className="text-muted-foreground">
                          {" "}
                          — {billing.compedNote}
                        </span>
                      )}
                    </span>
                  ) : (
                    "—"
                  )}
                </DefinitionRow>
                <DefinitionRow label="lifetime_purchased_at">
                  {billing.lifetimePurchasedAt ? (
                    <RelativeTime date={billing.lifetimePurchasedAt} />
                  ) : (
                    "—"
                  )}
                </DefinitionRow>
                <DefinitionRow label="subscription">
                  {billing.subscriptionPlan ? (
                    <span
                      className={cn(
                        billing.subscriptionStatus === "past_due" &&
                          "text-destructive"
                      )}
                    >
                      {billing.subscriptionPlan} · {billing.subscriptionStatus}
                      {billing.subscriptionPeriodEnd && (
                        <>
                          {" "}
                          · ends{" "}
                          {billing.subscriptionPeriodEnd
                            .toISOString()
                            .slice(0, 10)}
                        </>
                      )}
                    </span>
                  ) : (
                    "—"
                  )}
                </DefinitionRow>
                <DefinitionRow label="stripe_customer_id">
                  {billing.stripeCustomerId ? (
                    <span className="font-mono text-xs">
                      {billing.stripeCustomerId}
                    </span>
                  ) : (
                    "—"
                  )}
                </DefinitionRow>
              </dl>

              {/*
                Rendered straight from the same `entitlementsForPlan` output every gate in
                the app reads, so this panel cannot drift from the real paywall.
              */}
              <div className="mt-3 border-t border-border/60 pt-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  Entitlements
                </div>
                <div className="mt-1.5 flex flex-wrap gap-2 text-xs">
                  <span className="rounded bg-muted px-1.5 py-0.5">
                    contacts{" "}
                    <span className="tabular-nums">
                      {ent.contactLimit === null ? "∞" : ent.contactLimit}
                    </span>
                  </span>
                  {entitlementFlags.map(([label, allowed]) => (
                    <span
                      key={label}
                      className={cn(
                        "rounded px-1.5 py-0.5",
                        allowed
                          ? "bg-primary/10 text-primary"
                          : "bg-muted text-muted-foreground line-through"
                      )}
                    >
                      {label}
                    </span>
                  ))}
                </div>
                {ent.canUseHostedEnrichment && (
                  <p className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
                    <AlertTriangle className="size-3" aria-hidden />
                    Hosted enrichment is on — this account bills Orbit&apos;s Apollo
                    credits, and enrichment has no per-day ceiling.
                  </p>
                )}
              </div>
            </AdminPanel>
          </section>

          <section id="health" className="scroll-mt-20">
            <AdminPanel title="Health & errors">
              {health.length === 0 ? (
                <EmptyState>Nothing failing.</EmptyState>
              ) : (
                <ul className="space-y-2">
                  {health.map((item, i) => (
                    <li
                      key={`${item.kind}-${i}`}
                      className="rounded-lg border border-border/60 p-2.5"
                    >
                      <div className="flex items-center gap-2">
                        <CircleAlert
                          className={cn(
                            "size-3.5 shrink-0",
                            item.severity === "error"
                              ? "text-destructive"
                              : "text-accent-foreground"
                          )}
                          aria-hidden
                        />
                        <span className="text-sm">{item.label}</span>
                        {item.at && (
                          <span className="ml-auto text-xs text-muted-foreground">
                            <RelativeTime date={item.at} /> ago
                          </span>
                        )}
                      </div>
                      {/* System output, not user content — shown verbatim. */}
                      {item.detail && (
                        <p className="mt-1 whitespace-pre-wrap break-words pl-5.5 font-mono text-xs text-muted-foreground">
                          {item.detail}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </AdminPanel>
          </section>

          <section id="footprint" className="scroll-mt-20">
            <AdminPanel title="Data footprint">
              <dl className="grid gap-x-8 sm:grid-cols-2">
                <DefinitionRow label="Contacts">{footprint.contacts}</DefinitionRow>
                <DefinitionRow label="Companies">{footprint.companies}</DefinitionRow>
                <DefinitionRow label="Interactions">
                  {footprint.interactions}
                </DefinitionRow>
                <DefinitionRow label="Reminders">
                  {footprint.reminders}
                  {footprint.remindersPending > 0 &&
                    ` (${footprint.remindersPending} pending)`}
                </DefinitionRow>
                <DefinitionRow label="Suggested reminders">
                  {footprint.suggestedReminders}
                </DefinitionRow>
                <DefinitionRow label="Tags">{footprint.tags}</DefinitionRow>
                <DefinitionRow label="Chat threads">
                  {footprint.chatThreads}
                </DefinitionRow>
                <DefinitionRow label="Chat messages">
                  {footprint.chatMessages}
                </DefinitionRow>
                <DefinitionRow label="Imports">{footprint.imports}</DefinitionRow>
                <DefinitionRow label="Embeddings">
                  {footprint.embeddings}
                </DefinitionRow>
                <DefinitionRow label="Suggestions">
                  {footprint.suggestions}
                </DefinitionRow>
                <DefinitionRow label="Outreach campaigns">
                  {footprint.outreachCampaigns}
                  {footprint.outreachProspects > 0 &&
                    ` · ${footprint.outreachProspects} prospects`}
                </DefinitionRow>
                {/* Hosted sends run on Orbit's own Resend and Twilio credits, so this is
                    the one footprint number that costs money. */}
                <DefinitionRow label="Outreach sent">
                  {footprint.outreachMessagesSent}
                </DefinitionRow>
                <DefinitionRow label="Recruiter links">
                  {footprint.recruiterLinks}
                </DefinitionRow>
                <DefinitionRow label="First contact">
                  {footprint.firstContactAt ? (
                    <>
                      <RelativeTime date={footprint.firstContactAt} /> ago
                    </>
                  ) : (
                    "—"
                  )}
                </DefinitionRow>
                <DefinitionRow label="Last write">
                  {footprint.lastWriteAt ? (
                    <>
                      <RelativeTime date={footprint.lastWriteAt} /> ago
                    </>
                  ) : (
                    "—"
                  )}
                </DefinitionRow>
              </dl>
            </AdminPanel>
          </section>

          <section id="usage" className="scroll-mt-20">
            <AdminPanel title="AI usage">
              {usage.totalCalls === 0 ? (
                <EmptyState>No AI calls recorded.</EmptyState>
              ) : (
                <>
                  <dl className="grid gap-x-8 sm:grid-cols-2">
                    <DefinitionRow label="Calls">{usage.totalCalls}</DefinitionRow>
                    <DefinitionRow label="Failed">
                      <span
                        className={cn(usage.failedCalls > 0 && "text-destructive")}
                      >
                        {usage.failedCalls}
                      </span>
                    </DefinitionRow>
                    <DefinitionRow label="Input tokens">
                      {usage.inputTokens.toLocaleString()}
                    </DefinitionRow>
                    <DefinitionRow label="Output tokens">
                      {usage.outputTokens.toLocaleString()}
                    </DefinitionRow>
                    <DefinitionRow label="Estimated spend">
                      {formatCostMicros(usage.estimatedCostMicros) ?? "—"}
                      <span className="ml-1 text-xs text-muted-foreground">
                        on their key
                      </span>
                    </DefinitionRow>
                    <DefinitionRow label="On Orbit's key">
                      <span
                        className={cn(
                          usage.onOrbitKey > 0 && "text-accent-foreground"
                        )}
                      >
                        {usage.onOrbitKey}
                      </span>
                    </DefinitionRow>
                  </dl>

                  {usage.byOperation.length > 0 && (
                    <div className="mt-3 border-t border-border/60 pt-3">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">
                        By operation
                      </div>
                      <ul className="mt-1.5 space-y-1 text-sm">
                        {usage.byOperation.slice(0, 8).map((op) => (
                          <li key={op.operation} className="flex justify-between gap-4">
                            <span className="font-mono text-xs">{op.operation}</span>
                            <span className="tabular-nums">
                              {op.calls}
                              {op.failures > 0 && (
                                <span className="text-destructive">
                                  {" "}
                                  ({op.failures} failed)
                                </span>
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {usage.recentErrors.length > 0 && (
                    <div className="mt-3 border-t border-border/60 pt-3">
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">
                        Recent errors
                      </div>
                      <ul className="mt-1.5 space-y-1 text-xs">
                        {usage.recentErrors.map((err, i) => (
                          <li key={i} className="flex justify-between gap-4">
                            <span className="font-mono text-destructive">
                              {err.errorKind}
                            </span>
                            <span className="text-muted-foreground">
                              {err.model} · <RelativeTime date={err.at} /> ago
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </AdminPanel>
          </section>

          <section id="config" className="scroll-mt-20">
            <AdminPanel title="Configuration">
              {/*
                Booleans only. Never call decryptOrNull() in admin code — not behind a reveal,
                not in a log line. If a key is broken, the error message diagnoses it.
              */}
              <dl>
                <DefinitionRow label="AI provider">
                  {configuration.aiProvider ?? "—"}
                  {!configuration.hasSelectedProviderKey && (
                    <span className="ml-2 text-destructive">
                      key not set — AI will fail
                    </span>
                  )}
                </DefinitionRow>
                <DefinitionRow label="AI model">
                  {configuration.aiModel ?? "—"}
                </DefinitionRow>
                <DefinitionRow label="Gemini key">
                  <SecretState present={configuration.keys.gemini} />
                </DefinitionRow>
                <DefinitionRow label="OpenAI key">
                  <SecretState present={configuration.keys.openai} />
                </DefinitionRow>
                <DefinitionRow label="Anthropic key">
                  <SecretState present={configuration.keys.anthropic} />
                </DefinitionRow>
                <DefinitionRow label="Apollo key">
                  <SecretState present={configuration.keys.apollo} />
                </DefinitionRow>
                <DefinitionRow label="Resend key">
                  <SecretState present={configuration.keys.resend} />
                </DefinitionRow>
                <DefinitionRow label="Twilio">
                  <SecretState present={configuration.keys.twilio} />
                </DefinitionRow>
                <DefinitionRow label="Calendar feed">
                  <SecretState
                    present={configuration.calendarFeedEnabled}
                    absentLabel="not generated"
                  />
                  {configuration.calendarFeedLastFetchedAt && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      fetched <RelativeTime date={configuration.calendarFeedLastFetchedAt} />{" "}
                      ago
                    </span>
                  )}
                </DefinitionRow>
                <DefinitionRow label="Goals">{configuration.goalCount}</DefinitionRow>
                <DefinitionRow label="Theme">
                  {identity.theme ?? "system"}
                </DefinitionRow>
              </dl>
            </AdminPanel>
          </section>

          <section id="timeline" className="scroll-mt-20">
            <AdminPanel title="Activity timeline">
              {timeline.entries.length === 0 ? (
                <EmptyState>No recorded activity.</EmptyState>
              ) : (
                <>
                  <ul className="space-y-1 text-sm">
                    {timeline.entries.map((entry, i) => (
                      <li
                        key={`${entry.resourceId ?? i}-${entry.kind}`}
                        className="flex items-baseline justify-between gap-4 border-b border-border/40 py-1 last:border-b-0"
                      >
                        <span className="min-w-0">
                          <span
                            className={cn(
                              "mr-2 inline-block w-20 shrink-0 text-xs",
                              entry.kind === "admin"
                                ? "text-accent-foreground"
                                : "text-muted-foreground"
                            )}
                          >
                            {entry.kind}
                          </span>
                          {entry.label}
                          {/* System output only — import and sync errors, never prose. */}
                          {entry.detail && (
                            <span className="ml-2 text-xs text-destructive">
                              {entry.detail}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          <RelativeTime date={entry.at} /> ago
                        </span>
                      </li>
                    ))}
                  </ul>

                  {/* Keyset, not OFFSET: the feed grows at the head while you page. */}
                  {timeline.hasMore && (
                    <Link
                      href={`/admin/users/${encodeURIComponent(identity.userId)}?before=${encodeURIComponent(
                        timeline.entries[timeline.entries.length - 1].at.toISOString()
                      )}#timeline`}
                      className="mt-3 block border-t border-border/40 pt-2 text-xs text-muted-foreground hover:text-primary"
                    >
                      Older activity →
                    </Link>
                  )}
                  {before && (
                    <Link
                      href={`/admin/users/${encodeURIComponent(identity.userId)}#timeline`}
                      className="mt-1 block text-xs text-muted-foreground hover:text-primary"
                    >
                      ← Back to the latest
                    </Link>
                  )}
                </>
              )}
            </AdminPanel>
          </section>

          <section id="contacts" className="scroll-mt-20">
            <AdminPanel
              title={`Contacts (${contactPage.total})`}
              action={
                <span className="text-xs text-muted-foreground">
                  this view is logged
                </span>
              }
            >
              <div className="mb-3">
                <ContactsFilterBar userId={identity.userId} q={contactsQ} />
              </div>

              {contactPage.rows.length === 0 ? (
                <EmptyState>
                  {contactsQ ? `No contacts match "${contactsQ}".` : "No contacts."}
                </EmptyState>
              ) : (
                <>
                  <AdminTable
                    head={
                      <>
                        <Th>Contact</Th>
                        <Th>Email</Th>
                        <Th>Company</Th>
                        <Th>Title</Th>
                        <Th numeric>Logged</Th>
                        <Th numeric>Added</Th>
                      </>
                    }
                  >
                    {contactPage.rows.map((contact) => (
                      <tr
                        key={contact.id}
                        className="border-b border-border/40 last:border-b-0 hover:bg-muted/40"
                      >
                        <Td>
                          <Link
                            href={`/admin/users/${encodeURIComponent(identity.userId)}/contacts/${contact.id}`}
                            className="hover:text-primary"
                          >
                            {contact.name}
                          </Link>
                        </Td>
                        <Td className="max-w-48">
                          <span className="block truncate">
                            {contact.email ?? "—"}
                          </span>
                        </Td>
                        <Td>{contact.company ?? "—"}</Td>
                        <Td>{contact.title ?? "—"}</Td>
                        <Td numeric>{contact.interactionCount}</Td>
                        <Td numeric>
                          <RelativeTime date={contact.createdAt} />
                        </Td>
                      </tr>
                    ))}
                  </AdminTable>

                  <div className="mt-3">
                    <Pager
                      page={contactPage.page}
                      pageCount={Math.max(
                        1,
                        Math.ceil(contactPage.total / contactPage.pageSize)
                      )}
                      total={contactPage.total}
                      pageSize={contactPage.pageSize}
                      label="contacts"
                      hrefFor={(target) => {
                        const params = new URLSearchParams({
                          contactsPage: String(target),
                        });
                        if (contactsQ) params.set("contactsQ", contactsQ);
                        return `/admin/users/${encodeURIComponent(identity.userId)}?${params.toString()}#contacts`;
                      }}
                    />
                  </div>
                </>
              )}
            </AdminPanel>
          </section>

          <section id="audit" className="scroll-mt-20">
            <AdminPanel title="Audit trail">
              {audit.length === 0 ? (
                <EmptyState>No admin actions on this account.</EmptyState>
              ) : (
                <ul className="space-y-1 text-sm">
                  {audit.map((entry) => (
                    <li
                      key={entry.id}
                      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-border/40 py-1.5 last:border-b-0"
                    >
                      <span className="font-mono text-xs text-accent-foreground">
                        {entry.action}
                      </span>
                      {entry.reason && (
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
                          {entry.reason}
                        </span>
                      )}
                      <span className="shrink-0 text-xs text-muted-foreground">
                        <RelativeTime date={entry.createdAt} /> ago
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </AdminPanel>
          </section>

          <section id="actions" className="scroll-mt-20">
            <AccountDangerZone
              targetUserId={identity.userId}
              email={identity.email}
              suspendedAt={identity.suspendedAt}
              suspendedReason={identity.suspendedReason}
              contactCount={footprint.contacts}
            />
          </section>
        </div>
      </div>
    </>
  );
}
