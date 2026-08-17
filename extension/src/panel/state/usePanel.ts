import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ConversationStarter,
  MeResponse,
  PageContext,
  ResolveResponse,
} from "@contract";
import { ApiError, createApi } from "@/lib/api";
import { readActivePage, type PageReadResult } from "@/lib/page";
import { useSession } from "./useSession";

export type PanelPhase =
  | "loading"
  | "signed-out"
  | "unsupported"
  | "error"
  | "ready";

export type PanelState = {
  phase: PanelPhase;
  page: PageContext | null;
  pageError: string | null;
  me: MeResponse | null;
  resolved: ResolveResponse | null;
  resolving: boolean;
  starters: ConversationStarter[];
  startersLoading: boolean;
  startersDegraded: boolean;
  error: string | null;
  /** Set when the user navigated away while holding unsaved work. */
  pendingUrl: string | null;
};

const INITIAL: PanelState = {
  phase: "loading",
  page: null,
  pageError: null,
  me: null,
  resolved: null,
  resolving: true,
  starters: [],
  startersLoading: false,
  startersDegraded: false,
  error: null,
  pendingUrl: null,
};

export function usePanel() {
  const session = useSession();
  const [state, setState] = useState<PanelState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);
  const dirtyRef = useRef(false);

  // Clerk hands back a new getToken identity on every render. Closing over it
  // directly made `api` -> `run` -> the mount effect all unstable, so the effect
  // re-ran on every render, called setState, and looped forever — which renders
  // as a blank panel. Read it through a ref so the api object is created once.
  const getTokenRef = useRef(session.getToken);
  getTokenRef.current = session.getToken;
  const api = useMemo(() => createApi(() => getTokenRef.current()), []);

  const loadStarters = useCallback(
    async (page: PageContext, contactId: string | null) => {
      setState((s) => ({ ...s, startersLoading: true }));
      try {
        const result = await api.starters({ page, contactId, limit: 3 });
        setState((s) => ({
          ...s,
          starters: result.starters,
          startersDegraded: result.degraded,
          startersLoading: false,
        }));
      } catch {
        // Suggestions are a nice-to-have: on failure the seed stays and the
        // section quietly stops loading rather than showing an error.
        setState((s) => ({ ...s, startersLoading: false }));
      }
    },
    [api]
  );

  const run = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Reset the data slices but keep the shell — in a persistent panel,
    // blanking to INITIAL on every navigation is a full-panel flash several
    // times a minute. The identity zone holds the previous person until the
    // new local read lands ~40ms later, which reads as a cut, not a teardown.
    setState((s) => ({
      ...s,
      resolved: null,
      resolving: true,
      starters: [],
      startersLoading: false,
      startersDegraded: false,
      error: null,
      pageError: null,
    }));

    // Read the page first and paint it immediately — it's local, so this lands
    // in tens of milliseconds while the network work is still in flight.
    const read: PageReadResult = await readActivePage();
    if (!read.ok) {
      setState((s) => ({
        ...s,
        phase: "unsupported",
        pageError: read.message,
        resolving: false,
      }));
      return;
    }
    const page = read.page;
    setState((s) => ({ ...s, page }));

    // Paint-first: everything above depends only on the local DOM read, so the
    // identity zone is on screen at ~40ms whether or not Clerk has finished
    // initialising. Gating this behind auth made the panel's first paint wait
    // on 1.3MB of SDK parse plus a session sync — the exact opposite of the
    // staged-arrival design. When the session resolves, `run` re-fires.
    if (!session.isLoaded) return;

    if (!session.isSignedIn) {
      setState((s) => ({ ...s, phase: "signed-out", resolving: false }));
      return;
    }

    try {
      const [me, resolved] = await Promise.all([
        api.me(controller.signal),
        api.resolve(page, controller.signal),
      ]);
      if (controller.signal.aborted) return;

      setState((s) => ({
        ...s,
        phase: "ready",
        me,
        resolved,
        resolving: false,
        starters: resolved.startersSeed,
      }));

      if (me.capabilities.hasAiKey) {
        void loadStarters(page, resolved.contact?.id ?? null);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const apiError = error as ApiError;
      setState((s) => ({
        ...s,
        phase: apiError.code === "unauthorized" ? "signed-out" : "error",
        error:
          apiError.code === "offline"
            ? "You're offline. Orbit will catch up when you're back."
            : apiError.message,
        resolving: false,
      }));
    }
  }, [api, loadStarters, session.isLoaded, session.isSignedIn]);

  useEffect(() => {
    void run();
    return () => abortRef.current?.abort();
  }, [run]);

  /**
   * Follow the tab.
   *
   * Unlike a popup, the panel stays open while the user browses profile after
   * profile — so it has to keep up or it is lying. LinkedIn is an SPA and fires
   * onUpdated repeatedly during a single navigation, hence the debounce; and we
   * only re-run when the *canonical* URL actually changes, so query-string
   * churn doesn't cause pointless work.
   *
   * `activeTab` survives same-document and same-domain navigation, so browsing
   * within LinkedIn keeps working without another click on the icon.
   */
  const lastUrlRef = useRef<string | null>(null);
  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        const url = tab?.url ?? null;
        if (!url || url === lastUrlRef.current) return;
        lastUrlRef.current = url;

        // A half-typed note or an edited capture field outranks the page: once
        // a draft exists the panel is bound to the draft, not to the tab.
        if (dirtyRef.current) {
          setState((s) => ({ ...s, pendingUrl: url }));
          return;
        }
        void run();
      }, 250);
    };

    const onUpdated = (
      _tabId: number,
      change: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab
    ) => {
      if (!tab.active) return;
      if (change.url || change.status === "complete") schedule();
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onActivated.addListener(schedule);
    return () => {
      window.clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onActivated.removeListener(schedule);
    };
  }, [session.isLoaded, run]);

  /** Re-run resolve after a write, so the panel reflects the new state. */
  const refresh = useCallback(async () => {
    if (!state.page) return;
    setState((s) => ({ ...s, resolving: true }));
    try {
      const resolved = await api.resolve(state.page);
      setState((s) => ({ ...s, resolved, resolving: false }));
    } catch {
      setState((s) => ({ ...s, resolving: false }));
    }
  }, [api, state.page]);

  const setDirty = useCallback((value: boolean) => {
    dirtyRef.current = value;
  }, []);

  /** Discard the held draft and move to the page the user is actually on. */
  const followPending = useCallback(() => {
    dirtyRef.current = false;
    setState((s) => ({ ...s, pendingUrl: null }));
    void run();
  }, [run]);

  return { state, setState, api, reload: run, refresh, setDirty, followPending };
}
