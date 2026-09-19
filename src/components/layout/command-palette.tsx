"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { OPEN_COMMAND_PALETTE_EVENT } from "@/lib/ask-bar-events";
import type { PaletteAskMode } from "@/components/layout/command-palette-dialog";

/**
 * Split out so the shell ships only the key listener. The dialog, its icon set and the
 * contact search behind it load the first time anyone presses ⌘K — the same trade
 * `AppShell` makes for the ask bar.
 */
const CommandPaletteDialog = dynamic(
  () =>
    import("@/components/layout/command-palette-dialog").then((m) => ({
      default: m.CommandPaletteDialog,
    })),
  { ssr: false }
);

/**
 * ⌘K / Ctrl+K from anywhere in the app: jump to a person or a page, start a capture, or
 * hand a question to the ask bar.
 *
 * Mounted by `AppShell`, so it exists on every signed-in route and nowhere else — not in
 * the admin console (see `AdminShell` for why) and not during onboarding, where the shell
 * returns before mounting chrome.
 */
export function CommandPalette({
  hidden,
  askMode,
}: {
  /** Surfaces hidden from this viewer; the palette leaves out anything leading to one. */
  hidden: ReadonlySet<string>;
  askMode: PaletteAskMode;
}) {
  const [open, setOpen] = useState(false);
  // Stays mounted after the first open so a second ⌘K does not wait on the chunk again.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      setLoaded(true);
      setOpen((was) => !was);
    }
    function onOpenRequest() {
      setLoaded(true);
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenRequest);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenRequest);
    };
  }, []);

  if (!loaded) return null;
  return (
    <CommandPaletteDialog open={open} onOpenChange={setOpen} hidden={hidden} askMode={askMode} />
  );
}
