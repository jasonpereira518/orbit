/**
 * Design harness — every panel state, side by side, on a plain web page.
 *
 * Chrome refuses browser automation on chrome-extension:// URLs, so the only
 * way to look at the panel has been to install it and squint. That is how a
 * completely unstyled build reached the user twice. This renders the *real*
 * components against fixtures on localhost, where it can be screenshotted and
 * iterated on — and it's also the only practical way to see the states that
 * are hard to produce on demand, like a sparse contact or a failed save.
 *
 * Fixtures only. No component is forked for the harness; if it looks right
 * here it looks right in the panel.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { CircleAlert, UserX, WifiOff } from "lucide-react";
import type {
  ContactSnapshot,
  ConversationStarter,
  MatchCandidate,
  MeResponse,
  PageContext,
} from "@contract";

/* Every browser call the panel makes goes through `@/lib/browser`, so the
 * harness installs a typed fake there instead of stubbing `globalThis.chrome`. */
import { installBrowser } from "@/lib/browser";
import type { OrbitApi } from "@/lib/api";
import { createFakeBrowser } from "./fake-browser";
// A read of "the tab" returns the profile fixture, so work history's full read
// has a page to send. Declared functions hoist; this runs only on a click.
const fakeBrowser = createFakeBrowser({ runExtractor: async () => page() });
installBrowser(fakeBrowser);
// Exposed so a CDP check can assert what a click actually did (e.g. which URL
// "See plans" opened), not merely that the button exists.
(window as unknown as { __fakeBrowserLog: unknown }).__fakeBrowserLog = fakeBrowser.log;

// Deliberately NOT importing App: it reaches usePanel -> Clerk, which throws
// outside a real extension. Every view below is imported directly instead.
const { Notice } = await import("@/panel/components/Notice");
const { IdentityZone, PanelHeader, VerdictZone, VerdictSkeleton } = await import(
  "@/panel/components/chassis"
);
const { OrbitGlyph } = await import("@/panel/components/orbit");
const { Button, Meta, Skeleton } = await import("@/panel/components/ui");
const { CaptureView } = await import("@/panel/views/CaptureView");
const { KnownContactView } = await import("@/panel/views/KnownContactView");
const { AmbiguousView } = await import("@/panel/views/AmbiguousView");
const { HomeView } = await import("@/panel/views/HomeView");
const { PeopleView } = await import("@/panel/views/PeopleView");
const { CompanyView } = await import("@/panel/views/CompanyView");
const { PickedPersonView } = await import("@/panel/views/PickedPersonView");
const { identityOnlyPage } = await import("@/lib/identity-page");
const { SettingsView } = await import("@/panel/views/SettingsView");
const { UpdateBand } = await import("@/panel/components/UpdateBand");
import "@/styles/panel.css";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const f = (value: string | null, source = "h1", confidence: "high" | "medium" | "low" = "high") =>
  value ? { value, source, confidence } : null;

function page(over: Partial<Record<string, string | null>> = {}): PageContext {
  // `??` would swallow an explicit null, which is exactly what the thin-page
  // fixture needs to express. Presence of the key is the signal.
  const pick = (key: string, fallback: string | null) =>
    key in over ? (over[key] ?? null) : fallback;
  const url = pick("url", "https://www.linkedin.com/in/amara-osei")!;
  return {
    schemaVersion: 1,
    site: "linkedin",
    adapterVersion: "linkedin-1",
    kind: "person",
    url,
    sourceUrl: url,
    capturedAt: new Date().toISOString(),
    identity: {
      name: f(pick("name", "Amara Osei")),
      headline: f(pick("headline", "VP Engineering at Stripe"), "document.title", "medium"),
      title: f(pick("title", "VP Engineering"), "headline", "medium"),
      company: f(pick("company", "Stripe"), "headline", "medium"),
      location: f(pick("location", "San Francisco"), "top-card", "low"),
      school: null,
      email: null,
      handle: f("amara-osei", "url"),
      profileUrl: f(url, "url"),
      photoUrl: null,
    },
    text: { blob: "profile text", truncated: false, charCount: 12, fromSelection: false },
    warnings: [],
  };
}

const starters: ConversationStarter[] = [
  {
    id: "a0",
    text: "It was great grabbing coffee in Berlin. Did you ever end up writing that RFC on the billing migration?",
    kind: "reconnect",
    basis: "Berlin conversation about the billing migration",
    source: "ai",
  },
  {
    id: "a1",
    text: "Congrats on the move to Stripe — how's the VP Engineering role treating you?",
    kind: "congrats",
    basis: "Their profile now says VP Engineering at Stripe",
    source: "ai",
  },
];

function contact(over: Partial<ContactSnapshot> = {}): ContactSnapshot {
  return {
    id: "c1",
    fullName: "Amara Osei",
    preferredName: null,
    company: "Stripe",
    title: "VP Engineering",
    location: "San Francisco",
    linkedinUrl: "https://www.linkedin.com/in/amara-osei",
    xHandle: null,
    photoUrl: null,
    relationshipScore: 4,
    priorityLevel: 1,
    closeness: 0.72,
    closenessTier: "inner",
    lastInteractionAt: new Date(Date.now() - 150 * 864e5).toISOString(),
    daysSinceLastInteraction: 150,
    nextFollowUpAt: null,
    followUpStatus: "none",
    isFollowUpOverdue: false,
    tags: ["payments"],
    keyFacts: ["Rebuilding their billing stack", "Runs a payments newsletter"],
    sharedInterests: ["Distributed systems"],
    opportunities: ["Could intro to the infra team"],
    openActionItems: ["Send the intro to Priya on design"],
    aiSummary: null,
    howMet: "Intro from Priya at the Stripe offsite",
    dateMet: new Date(Date.now() - 800 * 864e5).toISOString(),
    notesPreview:
      "Met through Priya. Very direct, prefers a written brief before any call. Leaving Acme was about the billing rewrite being cancelled twice.",
    recentInteractions: [
      {
        id: "i1",
        interactionType: "meeting",
        interactionDate: new Date(Date.now() - 150 * 864e5).toISOString(),
        summary:
          "Coffee in Berlin. Walked through their billing migration and the vendor lock-in problem. Said they'd share the RFC once written.",
      },
      {
        id: "i2",
        interactionType: "email",
        interactionDate: new Date(Date.now() - 190 * 864e5).toISOString(),
        summary: "Sent the Anthropic write-up they asked for.",
      },
      {
        id: "i3",
        interactionType: "reach_out",
        interactionDate: new Date(Date.now() - 240 * 864e5).toISOString(),
        summary: null,
      },
    ],
    openReminders: [
      {
        id: "r1",
        title: "Send the payments RFC",
        dueDate: new Date(Date.now() + 3 * 864e5).toISOString(),
      },
    ],
    ...over,
  };
}

const candidates: MatchCandidate[] = [
  {
    id: "c1",
    fullName: "Amara Osei",
    company: "Stripe",
    title: "Senior Engineer",
    reason: "Same name + company",
    confidence: 0.9,
  },
  {
    id: "c2",
    fullName: "A. Osei",
    company: "Stripe",
    title: "Product Manager",
    reason: "Same company",
    confidence: 0.6,
  },
];

const freeEntitlements = {
  plan: "free" as const,
  planLabel: "Free Plan",
  contactLimit: 250,
  contactsRemaining: 12,
  features: { starters: false, workHistory: false, company: false, search: false },
};

const listPage: PageContext = {
  ...page({ name: null, title: null, company: null, headline: null }),
  kind: "list",
  url: "https://www.linkedin.com/search/results/people/?keywords=stripe",
  candidates: [
    { name: "Amara Osei", profileUrl: "https://www.linkedin.com/in/amara-osei", subtitle: "VP Engineering at Stripe" },
    { name: "Ben Tate", profileUrl: "https://www.linkedin.com/in/ben-tate", subtitle: "Founder, Tidepool" },
    { name: "Priya Nair", profileUrl: "https://www.linkedin.com/in/priya-nair", subtitle: "Designer at Linear" },
  ],
};

const companyPage: PageContext = {
  ...page({ name: null, title: null, company: "Stripe", headline: "Payments infrastructure" }),
  kind: "company",
  url: "https://www.linkedin.com/company/stripe/",
  org: { name: "Stripe", linkedinSlug: "stripe" },
};

function me(over: { hasAiKey?: boolean } = {}): MeResponse {
  return {
    contractVersion: 1,
    user: { name: "Jordan Park", email: "jordan@example.com", imageUrl: null },
    capabilities: {
      hasAiKey: over.hasAiKey ?? true,
      hasApolloKey: false,
      aiProvider: "anthropic",
      aiProviderLabel: "Anthropic",
    },
    stats: { contactCount: 1248, dueFollowUpCount: 3 },
  };
}

/** What the panel's API returns in the harness — per method, so each view
 *  gets the shape it actually reads. Anything not listed gets a save result. */
const person = (id: string, fullName: string, title: string | null, company: string | null) => ({
  id,
  fullName,
  title,
  company,
  photoUrl: null,
});
const API_FIXTURES: Record<string, unknown> = {
  home: {
    today: new Date().toISOString().slice(0, 10),
    dueReminders: [
      {
        id: "h1",
        title: "Send the payments RFC",
        dueDate: new Date(Date.now() - 4 * 864e5).toISOString(),
        overdue: true,
        contact: { id: "c1", fullName: "Amara Osei", photoUrl: null },
      },
      {
        id: "h2",
        title: "Book the offsite venue",
        dueDate: new Date().toISOString(),
        overdue: false,
        contact: null,
      },
    ],
    dueReminderTotal: 7,
    recentContacts: [
      person("c1", "Amara Osei", "VP Engineering", "Stripe"),
      person("c2", "Ben Tate", "Founder", "Tidepool"),
      person("c3", "Chioma Eze", null, "Anthropic"),
    ],
  },
  searchContacts: {
    results: [person("c1", "Amara Osei", "VP Engineering", "Stripe")],
    mode: "keyword",
  },
  reminder: { reminderId: "h1", completion: null, restored: false },
  logInteraction: { interactionId: "i9" },
  gate: (body: { feature: string }) => ({
    recorded: true,
    upgradeUrl: `http://localhost:3000/pricing?from=extension&feature=${body.feature}`,
  }),
};

Object.assign(API_FIXTURES, {
  resolveBatch: {
    items: [
      { index: 0, status: "known", contact: person("c1", "Amara Osei", "VP Engineering", "Stripe") },
      { index: 1, status: "possible", contact: person("c2", "Ben Tate", "Founder", "Tidepool") },
      { index: 2, status: "new", contact: null },
    ],
  },
  company: { currentTotal: 3, formerTotal: 2, people: [], locked: true },
  resolve: {
    status: "confident",
    contact: contact(),
    candidates: [],
    suggested: null,
    changes: [],
    startersSeed: [starters[0]],
  },
});

const workHistory = {
  roles: [
    { organization: "Stripe", title: "VP Engineering", dates: "Mar 2022 – Present", isCurrent: true },
    { organization: "Stripe", title: "Director of Engineering", dates: "Jan 2019 – Mar 2022", isCurrent: false },
    { organization: "Square", title: "Staff Engineer", dates: "2015 – 2019", isCurrent: false },
    { organization: "Google", title: "Software Engineer", dates: "2011 – 2015", isCurrent: false },
  ],
  roleCount: 6,
  schools: [{ organization: "University of Ghana", title: "Computer Science", dates: "2007 – 2011", isCurrent: false }],
  schoolCount: 1,
  source: "extension" as const,
  capturedAt: new Date(Date.now() - 40 * 864e5).toISOString(),
};

const proEntitlements = {
  ...freeEntitlements,
  plan: "pro" as const,
  planLabel: "Pro",
  features: { starters: true, workHistory: true, company: true, search: true },
};

/** A fake API; `over` replaces individual methods' answers (e.g. a Pro plan). */
function makeApi(over: Record<string, unknown> = {}): OrbitApi {
  const answers: Record<string, unknown> = { ...API_FIXTURES, ...over };
  return new Proxy({}, {
    // A fixture may be a function of the request, so an answer can depend on
    // what the panel actually asked for.
    get: (_target, method: string) => async (body: unknown) => {
      const answer = answers[method];
      if (typeof answer === "function") return answer(body);
      return method in answers ? answer : { contact: contact(), created: true, warnings: [] };
    },
  }) as unknown as OrbitApi;
}

const api = makeApi({
  profile: { status: "saved", dropped: 0, shortened: ["experience"], workHistory: { ...workHistory, roleCount: 4, capturedAt: new Date().toISOString() } },
});
const conflictApi = makeApi({
  profile: (body: { confirmMismatch?: boolean }) =>
    body.confirmMismatch
      ? { status: "saved", dropped: 0, workHistory }
      : {
          status: "conflict",
          dropped: 0,
          conflict: { pageSlug: "amara-osei-2", contactSlug: "amara-osei", contactName: "Amara Osei" },
        },
});
const proApi = makeApi({
  company: {
    currentTotal: 3,
    formerTotal: 2,
    locked: false,
    people: [
      { ...person("c1", "Amara Osei", "VP Engineering", "Stripe"), relation: "current" },
      { ...person("c4", "Dana Wells", "Staff Engineer", "Stripe"), relation: "current" },
      { ...person("c3", "Chioma Eze", "Research", "Anthropic"), relation: "former" },
    ],
  },
});

function panelState(over: Record<string, unknown> = {}) {
  return {
    phase: "ready",
    page: page(),
    pageError: null,
    me: null,
    resolved: {
      status: "none",
      contact: null,
      candidates: [],
      suggested: {
        fullName: "Amara Osei",
        firstName: "Amara",
        lastName: "Osei",
        company: "Stripe",
        title: "VP Engineering",
        location: "San Francisco",
        school: null,
        email: null,
        linkedinUrl: "https://www.linkedin.com/in/amara-osei",
        xHandle: null,
        website: null,
        photoUrl: null,
        tagNames: ["linkedin"],
        howMet: "Found on LinkedIn",
      },
      changes: [],
      startersSeed: starters,
    },
    resolving: false,
    starters,
    startersLoading: false,
    startersDegraded: false,
    error: null,
    pendingUrl: null,
    ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

function Frame({
  label,
  note,
  children,
}: {
  label: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 12, fontWeight: 600, fontFamily: "system-ui" }}>
        {label}
        {note ? (
          <span style={{ fontWeight: 400, opacity: 0.55 }}> — {note}</span>
        ) : null}
      </div>
      <div
        style={{
          width: 400,
          height: 660,
          border: "1px solid rgba(128,128,128,.35)",
          borderRadius: 10,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          background: "var(--background)",
          color: "var(--foreground)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function States() {
  const rich = contact();
  const sparse = contact({
    keyFacts: [],
    sharedInterests: [],
    opportunities: [],
    openActionItems: [],
    recentInteractions: [],
    lastInteractionAt: null,
    daysSinceLastInteraction: null,
    closenessTier: "outer",
    closeness: 0.15,
    title: null,
    tags: [],
    notesPreview: null,
    openReminders: [],
  });
  // The overdue reminder and the banner are one thing seen twice: Snooze has to
  // move *that* row, not mint a second one, so the fixture gives them the same
  // due date the way the server does.
  const overdueAt = new Date(Date.now() - 21 * 864e5).toISOString();
  const overdue = contact({
    isFollowUpOverdue: true,
    nextFollowUpAt: overdueAt,
    closenessTier: "mid",
    openReminders: [
      { id: "r-overdue", title: "Follow up on the RFC", dueDate: overdueAt },
      {
        id: "r1",
        title: "Send the payments RFC",
        dueDate: new Date(Date.now() + 3 * 864e5).toISOString(),
      },
    ],
  });

  const changed = panelState({
    resolved: {
      ...panelState().resolved,
      status: "confident",
      contact: rich,
      changes: [
        { field: "title", from: "Senior Engineer", to: "VP Engineering" },
        { field: "company", from: "Acme", to: "Stripe" },
      ],
    },
  });

  return (
    <>
      <Frame label="Capture" note="the hero — stranger on LinkedIn">
        <PanelHeader />
        <IdentityZone page={page()} />
        <VerdictZone>New to your orbit</VerdictZone>
        <CaptureView page={page()} state={panelState()} api={api} onSaved={() => {}} />
      </Frame>

      <Frame label="Capture — thin page" note="only a name was readable">
        <PanelHeader />
        <IdentityZone page={page({ title: null, company: null, location: null, headline: null })} />
        <VerdictZone>New to your orbit</VerdictZone>
        <CaptureView
          page={page({ title: null, company: null, location: null, headline: null })}
          state={panelState({ resolved: { ...panelState().resolved, suggested: null } })}
          api={api}
          onSaved={() => {}}
        />
      </Frame>

      <Frame label="Known contact" note="rich record + profile diff">
        <PanelHeader />
        <IdentityZone page={page()} />
        <VerdictZone>
          <OrbitGlyph tier="inner" size={16} />
          <span style={{ flex: 1 }}>Inner orbit · last spoke 5 months ago</span>
        </VerdictZone>
        <KnownContactView
          contact={rich}
          page={page()}
          state={changed}
          api={api}
          onChanged={() => {}}
        />
      </Frame>

      <Frame label="Known contact — free plan" note="AI lines locked, heuristics shown">
        <PanelHeader onSettings={() => {}} />
        <IdentityZone page={page()} />
        <VerdictZone>
          <OrbitGlyph tier="inner" size={16} />
          <span style={{ flex: 1 }}>Inner orbit · last spoke 5 months ago</span>
        </VerdictZone>
        <KnownContactView
          contact={contact({ openReminders: [], notesPreview: null, tags: [] })}
          page={page()}
          state={panelState({
            starters: [starters[0]],
            startersDegraded: true,
            startersDegradedReason: "plan",
          })}
          api={api}
          onChanged={() => {}}
        />
      </Frame>

      <Frame label="Work history — Pro" note="stored history; the profile lists only some roles">
        <PanelHeader />
        <IdentityZone page={page()} />
        <VerdictZone>
          <OrbitGlyph tier="inner" size={16} />
          <span style={{ flex: 1 }}>Inner orbit · last spoke 5 months ago</span>
        </VerdictZone>
        <KnownContactView
          contact={contact({ workHistory, openReminders: [], notesPreview: null })}
          page={{ ...page(), warnings: ["experience-shortened"] }}
          state={panelState({ me: { ...me(), contractVersion: 2, entitlements: proEntitlements } })}
          api={api}
          onChanged={() => {}}
        />
      </Frame>

      <Frame label="Work history — details page" note="click to see the conflict question">
        <PanelHeader />
        <IdentityZone page={{ ...page({ name: null }), section: "experience" }} />
        <VerdictZone>
          <OrbitGlyph tier="mid" size={16} />
          <span style={{ flex: 1 }}>Mid orbit · last spoke 2 months ago</span>
        </VerdictZone>
        <KnownContactView
          contact={contact({ openReminders: [], notesPreview: null, keyFacts: [], sharedInterests: [] })}
          page={{ ...page({ name: null }), section: "experience" }}
          state={panelState({ me: { ...me(), contractVersion: 2, entitlements: proEntitlements } })}
          api={conflictApi}
          onChanged={() => {}}
        />
      </Frame>

      <Frame label="Work history — free plan" note="Apollo history shows; reading is Pro">
        <PanelHeader />
        <IdentityZone page={page()} />
        <VerdictZone>
          <OrbitGlyph tier="inner" size={16} />
          <span style={{ flex: 1 }}>Inner orbit · last spoke 5 months ago</span>
        </VerdictZone>
        <KnownContactView
          contact={contact({
            workHistory: { ...workHistory, source: "apollo", roles: workHistory.roles.slice(0, 2), roleCount: 2 },
            openReminders: [],
            notesPreview: null,
          })}
          page={page()}
          state={panelState({ me: { ...me(), contractVersion: 2, entitlements: freeEntitlements } })}
          api={api}
          onChanged={() => {}}
        />
      </Frame>

      <Frame label="Known contact — sparse" note="the common imported contact">
        <PanelHeader />
        <IdentityZone page={page()} />
        <VerdictZone>
          <OrbitGlyph tier="outer" size={16} />
          <span style={{ flex: 1 }}>Outer orbit · never spoken</span>
        </VerdictZone>
        <KnownContactView
          contact={sparse}
          page={page()}
          state={panelState({ starters: [starters[1]] })}
          api={api}
          onChanged={() => {}}
        />
      </Frame>

      <Frame label="Overdue follow-up" note="the one element allowed to shout">
        <PanelHeader />
        <IdentityZone page={page()} />
        <VerdictZone tone="alert">
          <OrbitGlyph tier="mid" size={16} />
          <span style={{ flex: 1 }}>Mid orbit · last spoke 5 months ago</span>
        </VerdictZone>
        <KnownContactView
          contact={overdue}
          page={page()}
          state={panelState()}
          api={api}
          onChanged={() => {}}
        />
      </Frame>

      <Frame label="Ambiguous" note="viewing and merging are different verbs">
        <PanelHeader />
        <IdentityZone page={page()} />
        <VerdictZone tone="accent">Might be someone you know</VerdictZone>
        <AmbiguousView candidates={candidates} onPick={() => {}} onCreateNew={() => {}} />
      </Frame>

      <Frame label="People — search results" note="who you know, then one at a time">
        <PanelHeader onSettings={() => {}} />
        <IdentityZone page={listPage} />
        <VerdictZone>3 people on this page</VerdictZone>
        <PeopleView page={listPage} api={api} onPick={() => {}} />
      </Frame>

      <Frame label="Company — free" note="counts free, names are Pro">
        <PanelHeader onSettings={() => {}} />
        <IdentityZone page={companyPage} />
        <VerdictZone>Who you know at Stripe</VerdictZone>
        <CompanyView page={companyPage} api={api} />
      </Frame>

      <Frame label="Company — Pro">
        <PanelHeader onSettings={() => {}} />
        <IdentityZone page={companyPage} />
        <VerdictZone>Who you know at Stripe</VerdictZone>
        <CompanyView page={companyPage} api={proApi} />
      </Frame>

      <Frame label="Picked from a list" note="a person, with the way back">
        <PanelHeader onSettings={() => {}} />
        <PickedPersonView
          page={identityOnlyPage({ name: "Amara Osei", profileUrl: "https://www.linkedin.com/in/amara-osei" })!}
          backLabel="3 on this page"
          onBack={() => {}}
          baseState={panelState() as never}
          api={api}
        />
      </Frame>

      <Frame label="Home — unclicked tab" note="a hint, then useful anyway">
        <PanelHeader onSettings={() => {}} />
        <IdentityZone page={null} unread />
        <VerdictZone tone="accent">Not read yet — click the icon</VerdictZone>
        <HomeView
          reason="no-grant"
          detail={null}
          lostAccess={false}
          me={{ ...me({ hasAiKey: true }), entitlements: freeEntitlements }}
          signedIn
          api={api}
          onOpenSettings={() => {}}
          onSignIn={() => {}}
        />
      </Frame>

      <Frame label="Home — page about nobody" note="was 'Nothing to add here'">
        <PanelHeader onSettings={() => {}} />
        <IdentityZone page={page({ name: "Stripe", title: null, company: null, headline: "Payments infrastructure" })} />
        <VerdictZone>Not about a person</VerdictZone>
        <HomeView
          reason="no-person"
          detail={null}
          lostAccess={false}
          me={me()}
          signedIn
          api={api}
          onOpenSettings={() => {}}
          onSignIn={() => {}}
        />
      </Frame>

      <Frame label="Home — signed out">
        <PanelHeader onSettings={() => {}} />
        <IdentityZone page={null} unread />
        <VerdictZone tone="accent">Not read yet — click the icon</VerdictZone>
        <HomeView
          reason="no-grant"
          detail={null}
          lostAccess={false}
          me={null}
          signedIn={false}
          api={api}
          onOpenSettings={() => {}}
          onSignIn={() => {}}
        />
      </Frame>

      <Frame label="Settings" note="who am I, is AI on, which sites">
        <PanelHeader onSettings={() => {}} />
        <SettingsView
          me={me()}
          signedIn
          outdated={false}
          onClose={() => {}}
          onSignIn={() => {}}
        />
      </Frame>

      <Frame label="Settings — AI off" note="the free, no-key account">
        <PanelHeader onSettings={() => {}} />
        <SettingsView
          me={me({ hasAiKey: false })}
          signedIn
          outdated
          onClose={() => {}}
          onSignIn={() => {}}
        />
      </Frame>

      <Frame label="Settings — signed out">
        <PanelHeader onSettings={() => {}} />
        <SettingsView
          me={null}
          signedIn={false}
          outdated={false}
          onClose={() => {}}
          onSignIn={() => {}}
        />
      </Frame>

      <Frame label="Update available" note="server moved ahead of this build">
        <PanelHeader onSettings={() => {}} />
        <IdentityZone page={page()} />
        <VerdictZone>
          <OrbitGlyph tier="inner" size={16} />
          <span style={{ flex: 1 }}>Inner orbit · last spoke 5 months ago</span>
        </VerdictZone>
        <UpdateBand />
        <KnownContactView
          contact={rich}
          page={page()}
          state={panelState()}
          api={api}
          onChanged={() => {}}
        />
      </Frame>

      <Frame label="Loading" note="staged arrival, reserved heights">
        <PanelHeader />
        <IdentityZone page={page()} />
        <VerdictSkeleton />
        <div style={{ flex: 1, padding: 12, display: "grid", gap: 8, alignContent: "start" }}>
          <Skeleton className="h-2.5 w-24" />
          <Skeleton className="h-[86px] w-full" />
          <Skeleton className="h-[86px] w-full" />
        </div>
      </Frame>

      <Frame label="Signed out">
        <PanelHeader />
        <IdentityZone page={page()} />
        <VerdictZone tone="accent">Not signed in</VerdictZone>
        <Notice
          title="Orbit isn't signed in"
          body="Sign in once and the extension picks up your session automatically."
          action={
            <div style={{ display: "grid", gap: 12, paddingTop: 4 }}>
              <Button>Sign in to Orbit</Button>
              <Meta>Orbit only reads a page when you click the icon.</Meta>
            </div>
          }
        />
      </Frame>

      <Frame label="Nothing to add" note="company page / feed">
        <PanelHeader />
        <IdentityZone page={page({ name: null, title: null })} />
        <VerdictZone>Can&apos;t read this page</VerdictZone>
        <Notice
          icon={<UserX size={18} />}
          title="Nothing to add here"
          body="Orbit works on someone's profile. Open a person and it'll tell you whether you already know them."
        />
      </Frame>

      <Frame label="Error — no prior data" note="true failure, first load">
        <PanelHeader />
        <IdentityZone page={null} />
        <VerdictZone tone="accent">
          <CircleAlert size={11} />
          <span style={{ flex: 1 }}>Orbit couldn&apos;t check this one</span>
        </VerdictZone>
        <Notice
          icon={<CircleAlert size={18} />}
          title="Orbit is having a moment"
          body="Orbit sent an unreadable response."
          action={<Button variant="outline">Try again</Button>}
        />
      </Frame>

      <Frame label="Error — offline, stale data" note="the promise this pass fixes">
        <PanelHeader />
        <IdentityZone page={page()} stale />
        <VerdictZone tone="accent">
          <WifiOff size={11} />
          <span style={{ flex: 1 }}>Offline — showing what Orbit had</span>
          <button style={{ color: "var(--primary)" }}>Try again</button>
        </VerdictZone>
        <KnownContactView
          contact={rich}
          page={page()}
          state={changed}
          api={api}
          onChanged={() => {}}
        />
      </Frame>
    </>
  );
}

function Harness() {
  const [dark, setDark] = useState(false);
  document.documentElement.classList.toggle("dark", dark);
  document.body.style.background = dark ? "#1b1b1b" : "#f4f3ef";

  return (
    <div style={{ padding: 24, fontFamily: "system-ui" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <h1 style={{ fontSize: 16, margin: 0 }}>Orbit panel — states</h1>
        <button
          onClick={() => setDark((d) => !d)}
          style={{
            fontSize: 12,
            padding: "4px 10px",
            borderRadius: 6,
            border: "1px solid rgba(128,128,128,.4)",
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
          }}
        >
          {dark ? "Light" : "Dark"}
        </button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
        <States />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>
);
