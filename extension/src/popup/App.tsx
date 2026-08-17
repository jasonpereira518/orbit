import { useState } from "react";
import { CircleAlert, ExternalLink, WifiOff } from "lucide-react";
import type { MatchCandidate } from "@contract";
import { APP_URL } from "@/lib/env";
import { isPersonPage } from "@/lib/page";
import { PageContextStrip } from "./components/PageContextStrip";
import { Button, Skeleton } from "./components/ui";
import { AmbiguousView } from "./views/AmbiguousView";
import { KnownContactView } from "./views/KnownContactView";
import { UnknownPersonView } from "./views/UnknownPersonView";
import { usePanel } from "./state/usePanel";

function Header() {
  return (
    <header className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
      <span
        className="text-[15px] font-medium"
        style={{ fontFamily: "var(--font-display), serif" }}
      >
        Orbit
      </span>
      <button
        onClick={() => chrome.tabs.create({ url: `${APP_URL}/dashboard` })}
        title="Open Orbit"
        className="rounded-full p-1 text-[var(--muted-foreground)] hover:bg-[var(--accent)]"
      >
        <ExternalLink size={14} />
      </button>
    </header>
  );
}

function Centered({
  icon,
  title,
  body,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
      {icon ? <div className="text-[var(--muted-foreground)]">{icon}</div> : null}
      <p className="text-[14px] font-medium">{title}</p>
      {body ? (
        <p className="text-[12px] leading-snug text-[var(--muted-foreground)]">
          {body}
        </p>
      ) : null}
      {action}
    </div>
  );
}

export function App() {
  const { state, api, reload, refresh } = usePanel();
  const [forceCreate, setForceCreate] = useState(false);
  const [picked, setPicked] = useState<MatchCandidate | null>(null);

  const body = () => {
    if (state.phase === "signed-out") {
      return (
        <Centered
          title="Connect Orbit"
          body="Sign in to Orbit in this browser and the extension picks it up automatically."
          action={
            <Button
              className="mt-1"
              onClick={() => chrome.tabs.create({ url: `${APP_URL}/sign-in` })}
            >
              Sign in to Orbit
            </Button>
          }
        />
      );
    }

    if (state.phase === "unsupported") {
      return (
        <Centered
          title="Orbit can't read this page"
          body={state.pageError ?? undefined}
          action={
            <Button
              variant="outline"
              className="mt-1"
              onClick={() => chrome.tabs.create({ url: `${APP_URL}/contacts/new` })}
            >
              Add someone manually
            </Button>
          }
        />
      );
    }

    if (state.phase === "error") {
      const offline = state.error?.startsWith("You're offline");
      return (
        <Centered
          icon={offline ? <WifiOff size={20} /> : <CircleAlert size={20} />}
          title={offline ? "You're offline" : "Orbit is having a moment"}
          body={state.error ?? undefined}
          action={
            <Button variant="outline" className="mt-1" onClick={() => void reload()}>
              Try again
            </Button>
          }
        />
      );
    }

    if (state.resolving || !state.resolved || !state.page) {
      return (
        <div className="flex-1 space-y-2 px-4 py-3">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      );
    }

    // A company page, the feed, or a list — nothing to act on for one person.
    if (!isPersonPage(state.page) && state.resolved.status === "none") {
      return (
        <Centered
          title="No one to add here"
          body="Open someone's profile and Orbit will tell you whether you already know them."
        />
      );
    }

    const contact = state.resolved.contact;

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
      !forceCreate &&
      !picked
    ) {
      return (
        <AmbiguousView
          candidates={state.resolved.candidates}
          onPick={(candidate) => {
            setPicked(candidate);
            chrome.tabs.create({ url: `${APP_URL}/contacts/${candidate.id}` });
          }}
          onCreateNew={() => setForceCreate(true)}
        />
      );
    }

    return (
      <UnknownPersonView
        page={state.page}
        state={state}
        api={api}
        onSaved={() => {
          setForceCreate(false);
          void refresh();
        }}
      />
    );
  };

  return (
    <>
      <Header />
      <PageContextStrip page={state.page} />
      {body()}
    </>
  );
}
