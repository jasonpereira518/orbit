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
  PageContext,
} from "@contract";

/* The panel calls a handful of chrome.* APIs. Stub them before the components
 * are imported so a plain page can render them. */
type ChromeStub = {
  tabs: { create: (o: unknown) => void };
  permissions: {
    getAll: () => Promise<{ origins: string[] }>;
    request: () => Promise<boolean>;
    remove: () => Promise<boolean>;
  };
};
(globalThis as unknown as { chrome: ChromeStub }).chrome = {
  tabs: { create: (o) => console.log("tabs.create", o) },
  permissions: {
    getAll: async () => ({ origins: ["https://*.linkedin.com/*"] }),
    request: async () => true,
    remove: async () => true,
  },
};

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
const { GrantAccessView } = await import("@/panel/views/GrantAccessView");
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
    notesPreview: null,
    recentInteractions: [
      {
        id: "i1",
        interactionType: "meeting",
        interactionDate: new Date(Date.now() - 150 * 864e5).toISOString(),
        summary:
          "Coffee in Berlin. Walked through their billing migration and the vendor lock-in problem. Said they'd share the RFC once written.",
      },
    ],
    openReminders: [],
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api: any = new Proxy(
  {},
  { get: () => async () => ({ contact: contact(), created: true, warnings: [] }) }
);

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
    pendingOrigin: null,
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
  });
  const overdue = contact({
    isFollowUpOverdue: true,
    nextFollowUpAt: new Date(Date.now() - 21 * 864e5).toISOString(),
    closenessTier: "mid",
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

      <Frame label="Needs site access" note="the panel's activeTab problem">
        <PanelHeader />
        <IdentityZone page={null} />
        <VerdictZone tone="accent">Waiting on your go-ahead</VerdictZone>
        <GrantAccessView pendingOrigin={null} onGranted={() => {}} />
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
