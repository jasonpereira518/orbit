import { useEffect, useState } from "react";
import { CircleAlert, WifiOff } from "lucide-react";
import type { MatchCandidate, PageContext } from "@contract";
import { browser } from "@/lib/browser";
import { APP_URL } from "@/lib/env";
import { relativeTime } from "@/lib/format";
import { isPersonPage } from "@/lib/page";
import {
  IdentityZone,
  PanelHeader,
  VerdictSkeleton,
  VerdictZone,
} from "./components/chassis";
import { OrbitGlyph } from "./components/orbit";
import { Notice } from "./components/Notice";
import { Button, Meta, Skeleton } from "./components/ui";
import { AmbiguousView } from "./views/AmbiguousView";
import { CaptureView } from "./views/CaptureView";
import { HomeView } from "./views/HomeView";
import { CompanyView } from "./views/CompanyView";
import { PeopleView } from "./views/PeopleView";
import { PickedPersonView } from "./views/PickedPersonView";
import { identityOnlyPage } from "@/lib/identity-page";
import { KnownContactView } from "./views/KnownContactView";
import { usePanel, type ContextIntent } from "./state/usePanel";
import { deriveRoute } from "./state/route";
import { isOutdated } from "./state/update-status";
import { UpdateBand } from "./components/UpdateBand";
import { SettingsView } from "./views/SettingsView";
import { FixtureSaver } from "./dev/FixtureSaver";
import { emptyScope, scopeFor, type PageScope } from "./state/page-scope";

const TIER_WORD = {
  inner: "Inner orbit",
  mid: "Mid orbit",
  outer: "Outer orbit",
} as const;

/** See `state/page-scope.ts` — the rule, and why it is kept there. */
function usePageScopedState(url: string | null) {
  const [held, setHeld] = useState<PageScope>(() => emptyScope(url));
  const current = scopeFor(held, url);

  return {
    forceCreate: current.forceCreate,
    sealed: current.sealed,
    picked: current.picked,
    setForceCreate: (value: boolean) =>
      setHeld({ ...current, url, forceCreate: value }),
    setSealed: (value: boolean) => setHeld({ ...current, url, sealed: value }),
    setPicked: (value: PageContext | null) => setHeld({ ...current, url, picked: value }),
  };
}

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Right-click, handed up from the worker via usePanel. Declared before the
  // hook so it can be passed in; it runs later, after render.
  const [selectionNote, setSelectionNote] = useState<string | null>(null);
  const [contextNotice, setContextNotice] = useState<string | null>(null);
  const onContextIntent = (intent: ContextIntent) => {
    setSettingsOpen(false);
    if (intent.kind === "selection") {
      setSelectionNote(intent.text);
      return;
    }
    const linked = identityOnlyPage({ profileUrl: intent.linkUrl });
    if (!linked) {
      setContextNotice("That link isn't a profile Orbit can look up.");
      window.setTimeout(() => setContextNotice(null), 3500);
      return;
    }
    setSelectionNote(null);
    setPicked(linked);
  };

  const { state, api, signedIn, reload, refresh, setDirty, followPending } = usePanel({
    onContextIntent,
  });
  const pageUrl = state.page?.url ?? null;
  const { forceCreate, sealed, picked, setForceCreate, setSealed, setPicked } =
    usePageScopedState(pageUrl);
  const [signInClicked, setSignInClicked] = useState(false);

  const outdated = isOutdated(state.me?.contractVersion);

  const signIn = () => {
    browser().openTab(`${APP_URL}/sign-in`);
    setSignInClicked(true);
  };

  // The web app says the user just signed in (lib/handshake). A signed-out
  // panel starts over, which is what brings Clerk's synced session in — the
  // same thing "I've signed in" asks the user to do by hand. Only while signed
  // out: a signed-out panel holds no draft to lose.
  useEffect(() => {
    if (signedIn !== false) return;
    return browser().onSessionPoke(() => window.location.reload());
  }, [signedIn]);

  const contact = state.resolved?.contact ?? null;
  // Offline with prior data for *this same page* (usePanel only keeps
  // `resolved` set in that case — see its own comment) means there's a real
  // record to show, stale, instead of a dead end.
  const offlineError = state.phase === "error" && state.errorCode === "offline";
  const staleOffline = offlineError && Boolean(state.resolved);

  const route = deriveRoute({
    phase: state.phase,
    pageError: state.pageError,
    pageErrorReason: state.pageErrorReason,
    resolving: state.resolving,
    hasPage: Boolean(state.page),
    pageIsPerson: state.page ? isPersonPage(state.page) : false,
    status: state.resolved?.status ?? null,
    hasContact: Boolean(contact),
    candidateCount: state.resolved?.candidates.length ?? 0,
    forceCreate,
    staleOffline,
    listedPeople: state.page?.candidates?.length ?? 0,
    hasOrg: Boolean(state.page?.org),
  });

  // Once a draft exists the panel is bound to the draft, not to the tab — so
  // navigating away (or right-clicking something new) asks rather than
  // discarding what was typed. Rendered in EVERY branch: a picked person or a
  // note has its own verdict, and a hold nobody can see is held forever.
  const pendingBand = state.pendingUrl ? (
    <VerdictZone tone="accent">
      <span className="flex-1 truncate">
        You&apos;ve moved on — this isn&apos;t saved yet
      </span>
      <button
        onClick={followPending}
        className="shrink-0 text-[var(--primary)] hover:underline"
      >
        Discard
      </button>
    </VerdictZone>
  ) : null;

  const verdict = () => {
    if (pendingBand) return pendingBand;
    if (state.phase === "signed-out") {
      return <VerdictZone tone="accent">Not signed in</VerdictZone>;
    }
    if (state.phase === "needs-permission") {
      return <VerdictZone tone="accent">Not read yet — click the icon</VerdictZone>;
    }
    if (state.phase === "unsupported") {
      return <VerdictZone>Can&apos;t read this page</VerdictZone>;
    }
    if (state.phase === "error") {
      return (
        <VerdictZone tone="accent">
          {offlineError ? <WifiOff size={11} /> : <CircleAlert size={11} />}
          <span className="flex-1 truncate">
            {offlineError
              ? "Offline — showing what Orbit had"
              : "Orbit couldn't check this one"}
          </span>
          {/* Only render a retry here when it's the sole one on screen — the
              true-failure Notice below carries its own "Try again" button. */}
          {staleOffline ? (
            <button
              onClick={() => void reload()}
              className="shrink-0 text-[var(--primary)] hover:underline"
            >
              Try again
            </button>
          ) : null}
        </VerdictZone>
      );
    }
    if (route.name === "people") {
      return <VerdictZone>{state.page?.candidates?.length ?? 0} people on this page</VerdictZone>;
    }
    if (route.name === "company") {
      return <VerdictZone>Who you know at {state.page?.org?.name}</VerdictZone>;
    }
    if (route.name === "home" && route.reason === "no-person") {
      return <VerdictZone>Not about a person</VerdictZone>;
    }
    if (state.resolving || !state.resolved) return <VerdictSkeleton />;

    if (contact) {
      const spoke = relativeTime(contact.lastInteractionAt);
      return (
        <VerdictZone tone={contact.isFollowUpOverdue ? "alert" : "default"}>
          <OrbitGlyph tier={contact.closenessTier} size={16} />
          <span className="flex-1 truncate">
            {TIER_WORD[contact.closenessTier]}
            {spoke ? ` · last spoke ${spoke}` : " · never spoken"}
          </span>
        </VerdictZone>
      );
    }
    if (state.resolved.status === "ambiguous") {
      return <VerdictZone tone="accent">Might be someone you know</VerdictZone>;
    }
    return <VerdictZone>New to your orbit</VerdictZone>;
  };

  const body = () => {
    if (route.name === "signed-out") {
      return (
        <Notice
          title="Orbit isn't signed in"
          body={
            signInClicked
              ? undefined
              : "Sign in once and the extension picks up your session automatically."
          }
          action={
            signInClicked ? (
              <div className="space-y-2 pt-1">
                <Meta>Waiting for you to finish signing in…</Meta>
                <button
                  onClick={() => void reload()}
                  className="text-[12px] text-[var(--primary)] hover:underline"
                >
                  I&apos;ve signed in
                </button>
              </div>
            ) : (
              <div className="space-y-3 pt-1">
                <Button onClick={signIn}>
                  Sign in to Orbit
                </Button>
                <Meta>Orbit only reads a page when you click the icon.</Meta>
              </div>
            )
          }
        />
      );
    }

    if (route.name === "people" && state.page) {
      return (
        <PeopleView
          page={state.page}
          api={api}
          onPick={(candidate) => {
            const page = identityOnlyPage(candidate);
            if (page) setPicked(page);
          }}
        />
      );
    }

    if (route.name === "company" && state.page) {
      return <CompanyView page={state.page} api={api} />;
    }

    if (route.name === "home") {
      return (
        <HomeView
          reason={route.reason}
          detail={route.detail}
          lostAccess={route.lostAccess}
          me={state.me}
          signedIn={signedIn}
          api={api}
          onOpenSettings={() => setSettingsOpen(true)}
          onSignIn={signIn}
          onDirtyChange={setDirty}
        />
      );
    }

    // A genuine failure with nothing to fall back on — the true-failure
    // Notice. Offline-with-stale-data falls through instead, rendering the
    // last-known KnownContactView/CaptureView/AmbiguousView below.
    if (route.name === "error") {
      return (
        <Notice
          icon={offlineError ? <WifiOff size={18} /> : <CircleAlert size={18} />}
          title="Orbit is having a moment"
          body={state.error ?? undefined}
          action={
            <Button variant="outline" onClick={() => void reload()}>
              Try again
            </Button>
          }
        />
      );
    }

    if (route.name === "loading" || !state.resolved || !state.page) {
      return (
        <div className="flex-1 space-y-2 px-3 py-3">
          <Skeleton className="h-2.5 w-24" />
          <Skeleton className="h-[86px] w-full" />
          <Skeleton className="h-[86px] w-full" />
        </div>
      );
    }

    if (route.name === "known" && contact) {
      return (
        <KnownContactView
          // Without this the view is reused across people, and every piece of
          // its own state — most dangerously a half-typed note — carries over
          // to whoever is on screen next. The note would then be saved against
          // the *new* contact's id.
          key={contact.id}
          contact={contact}
          page={state.page}
          state={state}
          api={api}
          onChanged={() => void refresh()}
          onDirtyChange={setDirty}
        />
      );
    }

    if (route.name === "ambiguous") {
      return (
        <AmbiguousView
          candidates={state.resolved.candidates}
          onPick={(candidate: MatchCandidate) =>
            browser().openTab(`${APP_URL}/contacts/${candidate.id}`)
          }
          onCreateNew={() => setForceCreate(true)}
        />
      );
    }

    return (
      <CaptureView
        page={state.page}
        state={state}
        api={api}
        onDirtyChange={setDirty}
        onSaved={() => {
          // The Seal: the ring closes around the avatar, then the panel
          // converges on the known-contact view for the person just added.
          // The user should feel they've arrived at knowing this person, not
          // that they received a receipt.
          setSealed(true);
          setForceCreate(false);
          window.setTimeout(() => void refresh(), 200);
        }}
      />
    );
  };

  return (
    <>
      <PanelHeader onSettings={() => setSettingsOpen((open) => !open)} />
      {settingsOpen ? (
        <SettingsView
          me={state.me}
          signedIn={state.phase !== "signed-out"}
          outdated={outdated}
          onClose={() => setSettingsOpen(false)}
          onSignIn={signIn}
          devTools={
            import.meta.env.DEV ? (
              <FixtureSaver page={state.page} />
            ) : undefined
          }
        />
      ) : null}
      {/* Hidden, not unmounted: a capture draft or a half-typed note lives in
          this subtree, and opening Settings must not throw it away. */}
      <div hidden={settingsOpen} className="flex min-h-0 flex-1 flex-col">
        {contextNotice ? (
          <div className="flex h-[28px] shrink-0 items-center border-b border-[var(--border)] px-3 text-[11px] text-[var(--muted-foreground)]">
            {contextNotice}
          </div>
        ) : null}
        {selectionNote !== null ? (
          <>
            <IdentityZone page={state.page} unread={!state.page} />
            {pendingBand ?? (
              <VerdictZone tone="accent">
                <span className="flex-1 truncate">Save to Orbit as a note</span>
              </VerdictZone>
            )}
            <HomeView
              key={selectionNote}
              reason="no-person"
              detail={null}
              lostAccess={false}
              me={state.me}
              signedIn={signedIn}
              api={api}
              onOpenSettings={() => setSettingsOpen(true)}
              onSignIn={signIn}
              onDirtyChange={setDirty}
              note={{
                text: selectionNote,
                // The person on screen is the likeliest subject; preselect them.
                suggested:
                  route.name === "known" && contact
                    ? {
                        id: contact.id,
                        fullName: contact.fullName,
                        company: contact.company,
                        title: contact.title,
                        photoUrl: contact.photoUrl,
                      }
                    : null,
                onDone: () => setSelectionNote(null),
              }}
            />
          </>
        ) : picked ? (
          <>
          {pendingBand}
          <PickedPersonView
            key={picked.url}
            page={picked}
            backLabel={
              state.page?.candidates?.length
                ? `${state.page.candidates.length} on this page`
                : "Back"
            }
            onBack={() => setPicked(null)}
            baseState={state}
            api={api}
            onDirtyChange={setDirty}
          />
          </>
        ) : (
          <>
            <IdentityZone
              page={state.page}
              sealed={sealed}
              stale={staleOffline}
              unread={state.phase === "needs-permission" || state.phase === "unsupported"}
            />
            {verdict()}
            {outdated ? <UpdateBand /> : null}
            {body()}
          </>
        )}
      </div>
    </>
  );
}
