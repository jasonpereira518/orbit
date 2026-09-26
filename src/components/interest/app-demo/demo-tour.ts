/**
 * The autoplay tour: one story across the four screens. Each beat points the cursor at a
 * `data-demo-target`, shows its caption, and optionally "clicks" by dispatching the same
 * action the real button dispatches. Pure data; `useDemoTour` plays it.
 */
import { TOUR_PERSON } from "./demo-cast";
import type { DemoAction, DemoState } from "./demo-state";

export type TourBeat = {
  target: string;
  caption: string;
  /** The click. A function when the action depends on state (the draft's turn id). */
  action?: DemoAction | ((state: DemoState) => DemoAction | null);
  /** How long to hold after the click (or the arrival), in ms. */
  dwell: number;
};

export const TOUR: TourBeat[] = [
  {
    target: `suggestion-${TOUR_PERSON}`,
    caption: "Orbit noticed Maya has gone quiet — you said you'd check in monthly.",
    dwell: 2600,
  },
  {
    target: `suggest-open-${TOUR_PERSON}`,
    caption: "Open her profile.",
    action: { type: "openProfile", id: TOUR_PERSON },
    dwell: 700,
  },
  {
    target: "profile-timeline",
    caption: "Everything in one place — pulled in from Gmail, Calendar and LinkedIn.",
    dwell: 3000,
  },
  {
    target: "profile-ask",
    caption: "Ask Orbit about her.",
    action: { type: "ask", q: "What did I promise Maya?" },
    dwell: 600,
  },
  {
    target: "chat-draft-btn",
    caption: "It remembers what you promised — and drafts the follow-up.",
    action: (s) => {
      const turn = [...s.chat].reverse().find((t) => t.role === "assistant");
      return turn ? { type: "draft", turnId: turn.id } : null;
    },
    dwell: 800,
  },
  {
    target: "chat-draft-card",
    caption: "It drafts. You decide what gets sent.",
    dwell: 2600,
  },
  {
    target: "nav-constellation",
    caption: "And you can always see where everyone sits.",
    action: { type: "go", screen: "constellation" },
    dwell: 700,
  },
  {
    target: `star-${TOUR_PERSON}`,
    caption: "Maya, in the Figma constellation — one of your mid-orbit ties.",
    action: { type: "star", id: TOUR_PERSON },
    dwell: 3200,
  },
  {
    target: "nav-dashboard",
    caption: "Back to who's next.",
    action: { type: "reset" },
    dwell: 1400,
  },
];
