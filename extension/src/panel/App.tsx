import { useState } from "react";
import { CircleAlert, MousePointerClick, UserX, WifiOff } from "lucide-react";
import type { MatchCandidate } from "@contract";
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
import { GrantAccessView } from "./views/GrantAccessView";
import { KnownContactView } from "./views/KnownContactView";
import { usePanel } from "./state/usePanel";

const TIER_WORD = {
  inner: "Inner orbit",
  mid: "Mid orbit",
  outer: "Outer orbit",
} as const;

export function App() {
  const { state, api, reload, refresh, setDirty, followPending } = usePanel();
  const [forceCreate, setForceCreate] = useState(false);
  const [sealed, setSealed] = useState(false);
  const [signInClicked, setSignInClicked] = useState(false);

  const contact = state.resolved?.contact ?? null;
  // Offline with prior data for *this same page* (usePanel only keeps
  // `resolved` set in that case — see its own comment) means there's a real
  // record to show, stale, instead of a dead end.
  const offlineError =
    state.phase === "error" && Boolean(state.error?.startsWith("You're offline"));
  const staleOffline = offlineError && Boolean(state.resolved);

  const verdict = () => {
    // Once a draft exists the panel is bound to the draft, not to the tab —
    // so navigating away asks rather than discarding what was typed.
    if (state.pendingUrl) {
      return (
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
      );
    }
    if (state.phase === "signed-out") {
      return <VerdictZone tone="accent">Not signed in</VerdictZone>;
    }
    if (state.phase === "needs-permission") {
      return <VerdictZone tone="accent">Waiting on your go-ahead</VerdictZone>;
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
    if (state.phase === "signed-out") {
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
                <Button
                  onClick={() => {
                    chrome.tabs.create({ url: `${APP_URL}/sign-in` });
                    setSignInClicked(true);
                  }}
                >
                  Sign in to Orbit
                </Button>
                <Meta>Orbit only reads a page when you click the icon.</Meta>
              </div>
            )
          }
        />
      );
    }

    if (state.phase === "needs-permission") {
      return (
        <GrantAccessView
          pendingOrigin={state.pendingOrigin}
          onGranted={() => void reload()}
        />
      );
    }

    if (state.phase === "unsupported") {
      const lostAccess = state.pageErrorReason === "injection-failed";
      return (
        <Notice
          icon={lostAccess ? <MousePointerClick size={18} /> : undefined}
          title={lostAccess ? "This page reloaded" : "Orbit can't read this page"}
          body={
            lostAccess
              ? "Orbit reads a page only when you ask it to. Click the Orbit icon to read this one."
              : (state.pageError ?? undefined)
          }
          action={
            <Button
              variant="outline"
              onClick={() =>
                chrome.tabs.create({ url: `${APP_URL}/contacts/new` })
              }
            >
              Add someone manually
            </Button>
          }
        />
      );
    }

    // A genuine failure with nothing to fall back on — the true-failure
    // Notice. Offline-with-stale-data falls through instead, rendering the
    // last-known KnownContactView/CaptureView/AmbiguousView below.
    if (state.phase === "error" && !staleOffline) {
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

    if (state.resolving || !state.resolved || !state.page) {
      return (
        <div className="flex-1 space-y-2 px-3 py-3">
          <Skeleton className="h-2.5 w-24" />
          <Skeleton className="h-[86px] w-full" />
          <Skeleton className="h-[86px] w-full" />
        </div>
      );
    }

    if (!isPersonPage(state.page) && state.resolved.status === "none") {
      return (
        <Notice
          icon={<UserX size={18} />}
          title="Nothing to add here"
          body="Orbit works on someone's profile. Open a person and it'll tell you whether you already know them."
        />
      );
    }

    if (contact && !forceCreate) {
      return (
        <KnownContactView
          contact={contact}
          page={state.page}
          state={state}
          api={api}
          onChanged={() => void refresh()}
        />
      );
    }

    if (
      state.resolved.status === "ambiguous" &&
      state.resolved.candidates.length > 0 &&
      !forceCreate
    ) {
      return (
        <AmbiguousView
          candidates={state.resolved.candidates}
          onPick={(candidate: MatchCandidate) =>
            chrome.tabs.create({ url: `${APP_URL}/contacts/${candidate.id}` })
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
      <PanelHeader />
      <IdentityZone page={state.page} sealed={sealed} stale={staleOffline} />
      {verdict()}
      {body()}
    </>
  );
}
