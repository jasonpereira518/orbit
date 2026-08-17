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
};

export function usePanel() {
  const session = useSession();
  const [state, setState] = useState<PanelState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);

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

    setState({ ...INITIAL });

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
  }, [api, loadStarters, session.isSignedIn]);

  useEffect(() => {
    if (!session.isLoaded) return;
    void run();
    return () => abortRef.current?.abort();
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

  return { state, setState, api, reload: run, refresh };
}
