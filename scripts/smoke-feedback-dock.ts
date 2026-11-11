/**
 * The feedback dock's pure pieces: which shape the viewport allows, how far each shape moves
 * the page and the toast column, what survives a reload, and that the dock's width is its own
 * claim store (so the notifications window, which also shifts the corner, never narrows the page).
 *
 * No DOM: `document.documentElement.style` is stubbed with a plain map.
 */
import { readFileSync } from "node:fs";
import { checker } from "./smoke/check";

const props = new Map<string, string>();
(globalThis as unknown as { document: unknown }).document = {
  documentElement: {
    style: {
      setProperty: (k: string, v: string) => props.set(k, v),
      removeProperty: (k: string) => props.delete(k),
    },
  },
};

async function main() {
  const { dockLayoutFor, parseDockSession, serializeDockSession, DOCK_MIN_VIEWPORT_PX, DOCK_GUTTER_PX } =
    await import("../src/lib/feedback-dock");
  const { claimDockWidth, claimCornerShift } = await import("../src/lib/corner-clearance");
  const t = checker();

  const phone = dockLayoutFor(390);
  t.check("a phone gets a full-width sheet and moves nothing", phone.mode === "phone" && phone.panelPx === null && phone.squeezePx === 0 && phone.shiftPx === 0);
  t.check("767 is still a phone, 768 is not", dockLayoutFor(767).mode === "phone" && dockLayoutFor(768).mode === "overlay");

  const tablet = dockLayoutFor(768);
  t.check("a tablet's overlay panel is 22rem and fits its two gutters", tablet.panelPx === 352 && 352 <= 768 - DOCK_GUTTER_PX * 2, String(tablet.panelPx));
  t.check("the overlay never squeezes the page but does move the toasts", tablet.squeezePx === 0 && tablet.shiftPx > 0);
  t.check("just under the dock line is an overlay", dockLayoutFor(DOCK_MIN_VIEWPORT_PX - 1).mode === "overlay");

  const laptop = dockLayoutFor(DOCK_MIN_VIEWPORT_PX);
  t.check("the dock line docks at 22rem", laptop.mode === "dock" && laptop.panelPx === 352, JSON.stringify(laptop));
  t.check("the page gives up the panel plus both gutters", laptop.squeezePx === 352 + DOCK_GUTTER_PX * 2 && laptop.shiftPx === laptop.squeezePx);
  const wide = dockLayoutFor(1440);
  t.check("wide screens get 24.5rem", wide.mode === "dock" && wide.panelPx === 392 && wide.squeezePx === 416);
  t.check("the page keeps >= 36rem beside the sidebar at the dock line", DOCK_MIN_VIEWPORT_PX - 272 - laptop.squeezePx >= 576, String(DOCK_MIN_VIEWPORT_PX - 272 - laptop.squeezePx));

  const view = { view: "thread", id: "0b1f9a52-7c1e-4d0a-9d1b-2f6c1d0e8a11" } as const;
  t.check("a session round-trips", JSON.stringify(parseDockSession(serializeDockSession(view))) === JSON.stringify(view));
  t.check("compose and list round-trip", parseDockSession(serializeDockSession({ view: "compose" }))?.view === "compose" && parseDockSession(serializeDockSession({ view: "list" }))?.view === "list");
  for (const [label, raw] of [
    ["null", null],
    ["empty", ""],
    ["not JSON", "{oops"],
    ["a number", "7"],
    ["unknown version", '{"v":2,"view":"list"}'],
    ["unknown view", '{"v":1,"view":"admin"}'],
    ["a thread with no id", '{"v":1,"view":"thread"}'],
    ["a thread id with slashes", '{"v":1,"view":"thread","id":"../../x"}'],
    ["a thread id that is not a string", '{"v":1,"view":"thread","id":4}'],
  ] as const) {
    t.check(`${label} reads as closed`, parseDockSession(raw) === null);
  }

  claimDockWidth("feedback", 416);
  t.check("the dock sets --orbit-dock-w", props.get("--orbit-dock-w") === "416px");
  t.check("and leaves the corner shift alone", props.get("--orbit-corner-shift") === undefined);
  claimCornerShift("notifications", 400);
  t.check("the notifications shift does not touch the page width", props.get("--orbit-dock-w") === "416px" && props.get("--orbit-corner-shift") === "400px");
  claimDockWidth("feedback", null);
  t.check("releasing removes the variable", props.get("--orbit-dock-w") === undefined);

  // Source guards: the panel must stay a non-modal aside. Reintroducing the Sheet brings back the
  // backdrop, the outside-press dismissal and the focus trap this replaced.
  const panel = readFileSync("src/components/feedback/feedback-panel.tsx", "utf8");
  t.check("the panel is not built on the modal Sheet", !/components\/ui\/(sheet|dialog)/.test(panel));
  t.check("the panel is a labelled aside with a close control", /<aside[\s\S]*aria-label="Feedback"/.test(panel) && /aria-label="Close feedback"/.test(panel));
  const css = readFileSync("src/app/theme.css", "utf8");
  t.check("theme.css pads [data-dock-squeeze] by --orbit-dock-w (padding, so the background stays full-bleed)", /\[data-dock-squeeze\]\s*\{[^}]*padding-right:\s*var\(--orbit-dock-w\)/.test(css));

  t.done("feedback-dock smoke tests");
}

void main();
