"use client";

/**
 * The always-mounted SHELL of meeting recording. Mounted once in `(app)/layout.tsx`, above
 * `AppShell`, so a meeting outlives the route.
 *
 * Deliberately small and import-light: the recorder, the live socket and the upload queue
 * (~120 KB of source) are the ENGINE, `meeting-engine.tsx`, and are loaded only when
 * something needs them — the capture panel mounting, or the calendar nudge about to offer a
 * recording (`preloadMeetingEngine`). Pages that never record never download it. Once
 * loaded the engine stays mounted for the life of the layout, because it owns the recording.
 *
 * What lives here rather than in the engine:
 *   - the setup form (title, attendees, include-mic, calendar emails), so it can be filled
 *     before the engine exists — the nudge does exactly that;
 *   - how many views of the meeting are on screen (the bottom-right widget steps aside while
 *     the full panel is showing);
 *   - the contexts every consumer reads, and an idle stand-in for the engine's state until
 *     it arrives (`ready: false`).
 *
 * Start and Resume must be disabled until `ready`: `getDisplayMedia` needs the click that
 * started it, so nothing in that click may wait for a download.
 *
 * Phases, the pause/finish rules and the numbering scheme are documented in the engine.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { MeetingAnalysis } from "@/actions/meetings";
import type { ResumableMeeting } from "@/lib/meeting-sessions";
import type { MeetingCandidate } from "@/lib/meeting-calendar";
import type { ChunkUploadStatus } from "@/lib/meeting-upload-queue";
import type { MeetingRecorderHandle } from "@/lib/use-meeting-recorder";
import type { LiveStatus } from "@/lib/use-meeting-live";

export type MeetingPhase = "setup" | "live" | "pausing" | "paused" | "finishing" | "analyzing";

export type SegmentView = {
  seq: number;
  startMs: number;
  text: string | null;
  silent: boolean;
  status: ChunkUploadStatus;
  detail?: string;
  /** "you" / "speaker-2" from the live path. Null for a chunk, which cannot tell. */
  speaker?: string | null;
};

/** Where a recording picks up, when it continues an existing meeting. */
export type ResumeTarget = {
  id: string;
  startSeq: number;
  offsetMs: number;
  /** Load the stored transcript first — a meeting this tab never recorded. */
  reload: boolean;
};

export type PendingAnalysis = { analysis: MeetingAnalysis; sessionId: string };

/** The setup form, handed to the engine. `emailsRef` maps lower-cased names to emails. */
export type MeetingFormState = {
  title: string;
  attendeesText: string;
  includeMic: boolean;
  emailsRef: { current: Record<string, string> };
};

/** Everything the engine owns. */
export type MeetingEngineSlice = {
  phase: MeetingPhase;
  /** Paused with the share and mic still open: Resume is one click. */
  shareKept: boolean;
  recorder: MeetingRecorderHandle;
  liveStatus: LiveStatus;
  liveInterim: string;
  /** Where on the meeting's timeline the current recorder started. */
  offsetMs: number;
  /** The meeting's length so far, across every pause. */
  totalMs: number;
  /** Past the length cap: nothing more can be recorded, only finished. */
  atCap: boolean;
  segments: SegmentView[];
  failedCount: number;
  pendingCount: number;
  heardNothing: boolean;
  reconnectSeqs: number[];
  sessionId: string | null;
  fatal: string | null;
  drainStuck: { backlog: number } | null;
  analysisError: string | null;
  micLost: boolean;
  busyAction: string | null;
  quotaWarnMinutes: number | null;
  quotaResetLabel: string;
  /** The notes box: one running block of text, sent when the meeting is finished. */
  sideNotes: string;
  setSideNotes: (v: string) => void;
  // Actions.
  startRecording: (target: ResumeTarget | null, source?: "display" | "mic") => void;
  /** `release` lets the share and mic go instead of keeping them for a one-click Resume. */
  pause: (opts?: { release?: boolean }) => void;
  resume: () => void;
  /** The user has confirmed the meeting is done. */
  finish: () => void;
  discard: (id: string) => Promise<boolean>;
  adoptForAnalysis: (meeting: ResumableMeeting) => Promise<void>;
  summarize: (force?: boolean) => void;
  retryUpload: () => void;
  retryFailedParts: () => void;
};

export type MeetingSession = MeetingEngineSlice & {
  /** The engine has loaded. Start and Resume stay disabled until then. */
  ready: boolean;
  // The setup form.
  title: string;
  setTitle: (v: string) => void;
  attendeesText: string;
  setAttendeesText: (v: string) => void;
  includeMic: boolean;
  setIncludeMic: (v: boolean) => void;
  /** Fill the form from a calendar event: its title, and who is on it (with their emails). */
  applyCalendarMeeting: (meeting: MeetingCandidate) => void;
};

/** The slice a page needs to coordinate with a meeting. Changes rarely, unlike the above. */
export type MeetingFlow = {
  /** A meeting is in flight — recording, paused, or being summarized. Locks the other tabs. */
  busy: boolean;
  /** The bottom-right widget has something to show. */
  widgetVisible: boolean;
  hasPendingAnalysis: boolean;
  claimAnalysis: () => PendingAnalysis | null;
  /** The panel on /capture is on screen: the widget and the nudge step aside. */
  panelOpen: boolean;
  /** This account's plan includes meeting recording (the calendar nudge only runs when true). */
  canUseMeetings: boolean;
  /** Register the panel as on screen. Returns the unregister. */
  registerInlineView: () => () => void;
};

const SessionContext = createContext<MeetingSession | null>(null);
const FlowContext = createContext<MeetingFlow | null>(null);

/** The full session. Null outside the provider (the admin shell). */
export function useMeetingSession(): MeetingSession | null {
  return useContext(SessionContext);
}

export function useMeetingFlow(): MeetingFlow | null {
  return useContext(FlowContext);
}

// ── The engine: loaded on demand, publishing through a store ──────────────────────────
//
// Hand-rolled rather than `next/dynamic` / `React.lazy`, like the constellation's loader
// (`graph/constellation-modules.ts`): `dynamic` only fetches when it first renders, and
// `lazy` suspends — holding a fallback for ~300 ms — even when the chunk is already there.
// This starts the download from `preloadMeetingEngine()` and reads the result synchronously.

type EngineModule = typeof import("@/components/capture/meeting-engine");
type EngineValue = {
  slice: MeetingEngineSlice;
  flow: { busy: boolean; hasPendingAnalysis: boolean; claimAnalysis: () => PendingAnalysis | null };
};

let engineModule: EngineModule | null = null;
let engineLoading: Promise<void> | null = null;
let engineValue: EngineValue | null = null;
const moduleListeners = new Set<() => void>();
const valueListeners = new Set<() => void>();

/** Start downloading the engine. Safe to call any number of times, from anywhere. */
export function preloadMeetingEngine(): void {
  if (engineModule || engineLoading) return;
  engineLoading = import("@/components/capture/meeting-engine")
    .then((m) => {
      engineModule = m;
      moduleListeners.forEach((l) => l());
    })
    .catch(() => {
      // A failed chunk fetch (offline, deploy in between): allow another attempt.
      engineLoading = null;
    });
}

/** Called by the engine on every render. */
export function publishEngine(value: EngineValue | null): void {
  engineValue = value;
  valueListeners.forEach((l) => l());
}

const subscribeModule = (l: () => void) => {
  moduleListeners.add(l);
  return () => void moduleListeners.delete(l);
};
const subscribeValue = (l: () => void) => {
  valueListeners.add(l);
  return () => void valueListeners.delete(l);
};

const noop = () => {};
const IDLE_SLICE: MeetingEngineSlice = {
  phase: "setup",
  shareKept: false,
  // Only the fields the setup view reads are real; the rest are read in phases that cannot
  // happen before the engine exists.
  recorder: {
    state: "idle",
    error: null,
    surface: null,
    micActive: false,
    recording: false,
    elapsedMs: 0,
  } as unknown as MeetingRecorderHandle,
  liveStatus: "off",
  liveInterim: "",
  offsetMs: 0,
  totalMs: 0,
  atCap: false,
  segments: [],
  failedCount: 0,
  pendingCount: 0,
  heardNothing: false,
  reconnectSeqs: [],
  sessionId: null,
  fatal: null,
  drainStuck: null,
  analysisError: null,
  micLost: false,
  busyAction: null,
  quotaWarnMinutes: null,
  quotaResetLabel: "",
  sideNotes: "",
  setSideNotes: noop,
  startRecording: noop,
  pause: noop,
  resume: noop,
  finish: noop,
  discard: async () => false,
  adoptForAnalysis: async () => {},
  summarize: noop,
  retryUpload: noop,
  retryFailedParts: noop,
};

export function MeetingSessionProvider({
  canUseMeetings,
  children,
}: {
  canUseMeetings: boolean;
  children: React.ReactNode;
}) {
  const [title, setTitle] = useState("");
  const [attendeesText, setAttendeesText] = useState("");
  const [includeMic, setIncludeMic] = useState(true);
  /** Emails for names that came from a calendar event, by lower-cased name. */
  const emailsRef = useRef<Record<string, string>>({});
  const [inlineViews, setInlineViews] = useState(0);

  const Engine = useSyncExternalStore(subscribeModule, () => engineModule, () => null)?.MeetingEngine;
  const engine = useSyncExternalStore(subscribeValue, () => engineValue, () => null);

  const form = useMemo<MeetingFormState>(
    () => ({ title, attendeesText, includeMic, emailsRef }),
    [title, attendeesText, includeMic]
  );

  const applyCalendarMeeting = (meeting: MeetingCandidate) => {
    emailsRef.current = Object.fromEntries(
      meeting.attendees.filter((a) => a.email).map((a) => [a.name.trim().toLowerCase(), a.email])
    );
    setTitle(meeting.title);
    setAttendeesText(meeting.attendees.map((a) => a.name).join(", "));
  };

  const registerInlineView = useCallback(() => {
    // The panel is about to be used: have the engine on its way before the first click.
    preloadMeetingEngine();
    setInlineViews((n) => n + 1);
    return () => setInlineViews((n) => n - 1);
  }, []);

  const session: MeetingSession = {
    ...(engine?.slice ?? IDLE_SLICE),
    ready: engine !== null,
    title,
    setTitle,
    attendeesText,
    setAttendeesText,
    includeMic,
    setIncludeMic,
    applyCalendarMeeting,
  };

  const busy = engine?.flow.busy ?? false;
  const hasPending = engine?.flow.hasPendingAnalysis ?? false;
  const claim = engine?.flow.claimAnalysis;
  const flow = useMemo<MeetingFlow>(
    () => ({
      busy,
      widgetVisible: (busy || hasPending) && inlineViews === 0,
      hasPendingAnalysis: hasPending,
      claimAnalysis: claim ?? (() => null),
      panelOpen: inlineViews > 0,
      canUseMeetings,
      registerInlineView,
    }),
    [busy, hasPending, claim, inlineViews, canUseMeetings, registerInlineView]
  );

  return (
    <FlowContext.Provider value={flow}>
      <SessionContext.Provider value={session}>
        {Engine && <Engine form={form} />}
        {children}
      </SessionContext.Provider>
    </FlowContext.Provider>
  );
}
