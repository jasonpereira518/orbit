"use client";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Box } from "@/lib/tour/rail-placement";
import { chooseSlot, HOME_SLOT, isCosmoSlot, nearestSlot, slotBox, type CosmoSlot, type SlotFrame } from "@/lib/cosmo/placement";

const HOME_KEY = "orbit:cosmo-slot";
/** Quiet time after a change before Cosmo re-decides where to sit, so it never jitters. */
const SETTLE_MS = 250;
/** What Cosmo steps out of the way of: open dialogs, sheets, menus and lists, and anything marked. */
const OBSTACLES = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-cosmo-avoid]';
const EDITABLE = 'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), textarea, select, [contenteditable="true"]';

function readHome(): CosmoSlot {
  try {
    const saved = localStorage.getItem(HOME_KEY);
    return isCosmoSlot(saved) ? saved : HOME_SLOT;
  } catch {
    return HOME_SLOT;
  }
}

const visible = (el: Element) =>
  typeof (el as HTMLElement).checkVisibility === "function" ? (el as HTMLElement).checkVisibility() : el.getClientRects().length > 0;
const boxOf = (el: Element): Box => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
};

/**
 * Where Cosmo sits right now. `home` is the person's choice (drag or arrow keys, kept per device);
 * `slot` is home unless something on the page is in the way, re-decided after the page settles,
 * never while the pointer is on Cosmo or it is being dragged. On a phone, a focused field (the
 * keyboard is up) tucks Cosmo into an edge tab until it is tapped.
 *
 * `rootRef` is Cosmo's column; `probeRef` an invisible box pinned to the shared bottom-right corner,
 * which is how the corner's live insets (nav band, lift, shift) are read in pixels.
 */
export function useCosmoPlacement(
  rootRef: RefObject<HTMLElement | null>,
  probeRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  /** Called just before Cosmo changes slot, so the view can note where it was and glide from there. */
  capture: () => void,
) {
  // Client-only (CosmoRoot is never server-rendered), so the saved slot can be read up front.
  const [home, setHomeState] = useState<CosmoSlot>(readHome);
  const [slot, setSlotState] = useState<CosmoSlot>(() => home);
  const slotRef = useRef(slot);
  const setSlot = useCallback(
    (next: CosmoSlot) => {
      if (next === slotRef.current) return;
      capture();
      slotRef.current = next;
      setSlotState(next);
    },
    [capture],
  );
  const [fieldFocused, setFieldFocused] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const busy = useRef(false);
  const homeRef = useRef(home);

  const frame = useCallback((): SlotFrame | null => {
    const el = rootRef.current;
    const corner = probeRef.current?.getBoundingClientRect();
    if (!el || !corner) return null;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const sidebar = document.querySelector("[data-app-sidebar]");
    const left = sidebar && visible(sidebar) && width >= 768 ? sidebar.getBoundingClientRect().right + 20 : 12;
    // Cosmo's real size is its children's, not the card-wide column's.
    let w = 0;
    for (const child of el.children) w = Math.max(w, child.getBoundingClientRect().width);
    const top = width >= 768 ? 112 : 72;
    // The left and top slots render from these, so what is solved is what is drawn.
    document.documentElement.style.setProperty("--cosmo-left", `${left}px`);
    document.documentElement.style.setProperty("--cosmo-top", `${top}px`);
    return {
      viewport: { width, height },
      insets: { left, right: width - corner.right, top, bottom: height - corner.bottom },
      size: { width: w || 48, height: el.getBoundingClientRect().height || 48 },
    };
  }, [rootRef, probeRef]);

  const solve = useCallback(() => {
    const el = rootRef.current;
    const f = frame();
    if (!el || !f || busy.current) return;
    const obstacles: Box[] = [];
    for (const node of document.querySelectorAll(OBSTACLES))
      if (!el.contains(node) && visible(node)) obstacles.push(boxOf(node));
    const focus = document.activeElement;
    if (focus && focus.matches(EDITABLE) && !el.contains(focus)) obstacles.push(boxOf(focus));
    setSlot(chooseSlot(homeRef.current, f, obstacles));
  }, [frame, rootRef, setSlot]);

  useEffect(() => {
    if (!enabled) return;
    let timer = 0;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(solve, SETTLE_MS);
    };
    const onFocus = () => {
      const focus = document.activeElement;
      setFieldFocused(Boolean(focus?.matches(EDITABLE) && !rootRef.current?.contains(focus)));
      setExpanded(false);
      schedule();
    };
    // Dialogs, menus and popovers are portalled straight into <body>.
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onFocus);
    document.addEventListener("click", schedule, true);
    frame(); // measure the left/top insets now, not 250ms from now
    schedule();
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onFocus);
      document.removeEventListener("click", schedule, true);
    };
  }, [enabled, solve, rootRef, frame]);

  /** The person moved Cosmo: that is home now, on this device. */
  const setHome = useCallback(
    (next: CosmoSlot) => {
      homeRef.current = next;
      setHomeState(next);
      setSlot(next);
      try {
        localStorage.setItem(HOME_KEY, next);
      } catch {
        /* Private mode: it stays put until reload. */
      }
    },
    [setSlot],
  );

  return {
    slot,
    home,
    /** Phone with the keyboard up: show a slim edge tab instead. */
    // Read only once a field has focus, which only happens in the browser.
    collapsed: fieldFocused && !expanded && window.matchMedia("(max-width: 767.98px)").matches,
    expand: () => setExpanded(true),
    /** Hold still while hovered or dragged; re-decide once released. */
    hold: (on: boolean) => {
      busy.current = on;
      if (!on) window.setTimeout(solve, SETTLE_MS);
    },
    /** A drop: the slot nearest where it was let go becomes home. Returns it (null: no frame). */
    drop: (rect: DOMRect): CosmoSlot | null => {
      const f = frame();
      if (!f) return null;
      const next = nearestSlot({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, f);
      setHome(next);
      return next;
    },
    /** Mid-drag: where it would land if let go now, as a box on screen (the drop preview). */
    landing: (rect: DOMRect): { slot: CosmoSlot; box: Box } | null => {
      const f = frame();
      if (!f) return null;
      const next = nearestSlot({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, f);
      return { slot: next, box: slotBox(next, f) };
    },
    setHome,
  };
}
