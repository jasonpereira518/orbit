/**
 * The panel is beside a tab it hasn't been given.
 *
 * This replaces the grant wall. The wall existed because Chrome's built-in
 * "open the panel on click" granted nothing, so the only way to read a page
 * was a standing permission per site. The click now grants the tab itself
 * (see background/index.ts), so this is an instruction, not an obstacle:
 * click, and it reads. Standing permissions still exist, but as a convenience
 * the user opts into from Settings — Orbit following them around a site
 * without a click each time — rather than a toll paid before anything works.
 */
import { useEffect, useState } from "react";
import { MousePointerClick } from "lucide-react";
import { browser } from "@/lib/browser";
import { Button, Meta } from "../components/ui";

export function TabHintView({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [shortcut, setShortcut] = useState<string | null>(null);
  useEffect(() => {
    void browser().actionShortcut().then(setShortcut);
  }, []);

  return (
    <div className="scroll-area flex-1 space-y-2 px-3 py-4">
      <MousePointerClick size={18} className="text-[var(--muted-foreground)]" />
      <p className="text-[14px] font-medium leading-snug">
        Click the Orbit icon to read this tab
      </p>
      <Meta className="max-w-[38ch]">
        Orbit reads a page only when you ask.{" "}
        {shortcut ? (
          <>
            Clicking the icon — or pressing{" "}
            <kbd className="rounded border border-[var(--border)] px-1 font-sans text-[10px]">
              {shortcut}
            </kbd>{" "}
            — lets it read this tab until you leave the site.
          </>
        ) : (
          <>Clicking the icon lets it read this tab until you leave the site.</>
        )}
      </Meta>
      <div className="pt-2">
        <Button size="sm" variant="outline" onClick={onOpenSettings}>
          Choose sites Orbit follows
        </Button>
        <Meta className="mt-1.5 max-w-[38ch]">
          For sites you visit often, Orbit can read each page as you open it,
          without a click. You choose the sites.
        </Meta>
      </div>
    </div>
  );
}
