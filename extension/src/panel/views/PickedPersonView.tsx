/**
 * One person picked from a list — or from a right-clicked link — shown with
 * the panel's normal person views, and a way back.
 *
 * The panel knows them only by an exact identity (see `lib/identity-page.ts`):
 * never by visiting their page. So this resolves that identity itself and hands
 * the result to the same Known / Capture / Ambiguous views a profile page gets,
 * with a panel state built for this person rather than for the tab.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { MatchCandidate, PageContext, ResolveResponse } from "@contract";
import type { OrbitApi } from "@/lib/api";
import { browser } from "@/lib/browser";
import { APP_URL } from "@/lib/env";
import { relativeTime } from "@/lib/format";
import { IdentityZone, VerdictSkeleton, VerdictZone } from "../components/chassis";
import { OrbitGlyph } from "../components/orbit";
import { Notice } from "../components/Notice";
import { Button, Skeleton } from "../components/ui";
import type { PanelState } from "../state/usePanel";
import { AmbiguousView } from "./AmbiguousView";
import { CaptureView } from "./CaptureView";
import { KnownContactView } from "./KnownContactView";

const TIER_WORD = { inner: "Inner orbit", mid: "Mid orbit", outer: "Outer orbit" } as const;

export function PickedPersonView({
  page,
  backLabel,
  onBack,
  baseState,
  api,
  onDirtyChange,
}: {
  page: PageContext;
  backLabel: string | null;
  onBack: () => void;
  /** The tab's panel state; this view swaps in the picked person's page and resolve. */
  baseState: PanelState;
  api: OrbitApi;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [resolved, setResolved] = useState<ResolveResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [forceCreate, setForceCreate] = useState(false);
  // Back is an in-panel action, so the tab's draft guard doesn't cover it.
  // Leaving a half-written capture or note about this person must be a choice.
  const dirtyRef = useRef(false);
  const trackDirty = useCallback(
    (dirty: boolean) => {
      dirtyRef.current = dirty;
      onDirtyChange?.(dirty);
    },
    [onDirtyChange]
  );
  const goBack = () => {
    if (dirtyRef.current && !window.confirm("Discard what you've written about this person?")) return;
    trackDirty(false);
    onBack();
  };

  const resolve = useCallback(async () => {
    setFailed(false);
    try {
      setResolved(await api.resolve(page));
    } catch {
      setFailed(true);
    }
  }, [api, page]);

  useEffect(() => {
    setResolved(null);
    setForceCreate(false);
    void resolve();
  }, [resolve]);

  const contact = resolved?.contact ?? null;
  const state: PanelState = {
    ...baseState,
    phase: "ready",
    page,
    resolved,
    resolving: resolved === null,
    starters: resolved?.startersSeed ?? [],
    startersLoading: false,
    // Picked from a list: there is no page text, so no AI lines — the
    // heuristic seed from /resolve is what there is, credited as such.
    startersDegraded: true,
    startersDegradedReason: "no_signal",
    parsed: null,
    parsing: false,
    error: null,
    errorCode: null,
    pendingUrl: null,
  };

  const back = backLabel ? (
    <button
      onClick={goBack}
      className="inline-flex shrink-0 items-center gap-1 text-[var(--primary)] hover:underline"
    >
      <ArrowLeft size={11} />
      {backLabel}
    </button>
  ) : null;

  const verdict = () => {
    if (failed) return <VerdictZone tone="accent"><span className="flex-1">Orbit couldn&apos;t check this one</span>{back}</VerdictZone>;
    if (!resolved) return <VerdictSkeleton />;
    if (contact && !forceCreate) {
      const spoke = relativeTime(contact.lastInteractionAt);
      return (
        <VerdictZone>
          <OrbitGlyph tier={contact.closenessTier} size={16} />
          <span className="flex-1 truncate">
            {TIER_WORD[contact.closenessTier]}
            {spoke ? ` · last spoke ${spoke}` : " · never spoken"}
          </span>
          {back}
        </VerdictZone>
      );
    }
    return (
      <VerdictZone tone={resolved.status === "ambiguous" ? "accent" : "default"}>
        <span className="flex-1 truncate">
          {resolved.status === "ambiguous" ? "Might be someone you know" : "New to your orbit"}
        </span>
        {back}
      </VerdictZone>
    );
  };

  const body = () => {
    if (failed) {
      return (
        <Notice
          title="Orbit is having a moment"
          action={<Button variant="outline" onClick={() => void resolve()}>Try again</Button>}
        />
      );
    }
    if (!resolved) {
      return (
        <div className="flex-1 space-y-2 px-3 py-3">
          <Skeleton className="h-2.5 w-24" />
          <Skeleton className="h-[86px] w-full" />
        </div>
      );
    }
    if (contact && !forceCreate) {
      return (
        <KnownContactView
          key={contact.id}
          contact={contact}
          page={page}
          state={state}
          api={api}
          onChanged={() => void resolve()}
          onDirtyChange={trackDirty}
        />
      );
    }
    if (resolved.status === "ambiguous" && resolved.candidates.length > 0 && !forceCreate) {
      return (
        <AmbiguousView
          candidates={resolved.candidates}
          onPick={(candidate: MatchCandidate) => browser().openTab(`${APP_URL}/contacts/${candidate.id}`)}
          onCreateNew={() => setForceCreate(true)}
        />
      );
    }
    return (
      <CaptureView
        page={page}
        state={state}
        api={api}
        onDirtyChange={trackDirty}
        onSaved={() => {
          setForceCreate(false);
          void resolve();
        }}
      />
    );
  };

  return (
    <>
      <IdentityZone page={page} />
      {verdict()}
      {body()}
    </>
  );
}
