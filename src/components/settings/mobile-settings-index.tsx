"use client";

import { useId } from "react";
import type { RailSection } from "@/components/settings/settings-section-nav";

/** A native chooser stays usable with touch, screen readers and large text. */
export function MobileSettingsIndex({ sections }: { sections: RailSection[] }) {
  const id = useId();
  if (!sections.length) return null;
  return (
    <div className="sticky top-0 z-20 rounded-xl border border-border/70 bg-background/95 p-3 backdrop-blur xl:hidden">
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted-foreground">Jump to section</label>
      <select
        id={id}
        defaultValue=""
        className="min-h-11 w-full rounded-lg border border-input bg-background px-3 text-base"
        onChange={(event) => {
          const target = document.getElementById(event.target.value);
          if (!target) return;
          target.scrollIntoView({ block: "start" });
          // Move the reading/focus position as well as the visual viewport.
          target.setAttribute("tabindex", "-1");
          target.focus({ preventScroll: true });
        }}
      >
        <option value="" disabled>Choose a section</option>
        {sections.map((section) => <option key={section.id} value={section.id}>{section.label}</option>)}
      </select>
    </div>
  );
}
