"use client";

import { Cloud, Library, Mic, NotebookPen, Upload, type LucideIcon } from "lucide-react";
import { motion } from "motion/react";
import { useRouter } from "next/navigation";
import { SPRING_PILL } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

export type CaptureMode = "messy" | "voice" | "meeting" | "library" | "cloud";
/**
 * A tab on /capture. `"imports"` is not a capture mode: the import hub renders server-side on
 * `/capture?mode=imports`, so choosing it navigates instead of switching local state.
 */
export type CaptureTab = CaptureMode | "imports";

/** `"meeting"` is the recorder on /meetings, which hosts the same flow with no tabs. */
export const CAPTURE_MODES: ReadonlyArray<{ id: CaptureTab; label: string; blurb: string; icon: LucideIcon }> = [
  {
    id: "messy",
    icon: NotebookPen,
    label: "Messy Notes",
    blurb:
      "Paste notes about one person or many — typed, photographed, or a PDF. Orbit pulls each person out and you review them one card at a time.",
  },
  {
    id: "voice",
    icon: Mic,
    label: "Voice",
    blurb:
      "Just finished a conversation? Say who you met and what you agreed — Orbit transcribes it, then pulls out the people.",
  },
  {
    id: "library",
    icon: Library,
    label: "Notes Library",
    blurb:
      "Backfilling? Drop a folder of meeting notes and each file becomes its own meeting — its own date, its own people, its own entry on their timeline.",
  },
  {
    id: "cloud",
    icon: Cloud,
    label: "Drive & OneDrive",
    blurb:
      "Pick meeting notes straight from Google Drive or OneDrive — one or a stack of them. Each becomes its own capture to review.",
  },
  {
    id: "imports",
    icon: Upload,
    label: "Imports",
    blurb:
      "Bring in your exports and accounts — a LinkedIn ZIP, contacts files, calendars, Google and Outlook. Once they're in, browse everything in Knowledge.",
  },
];

export function captureTabId(mode: CaptureTab) {
  return `capture-tab-${mode}`;
}

export function capturePanelId(mode: CaptureTab) {
  return `capture-panel-${mode}`;
}

/**
 * The ways in, as a pill tab bar. The same `layoutId` pill every segmented control in the
 * app uses, plus the tab/tabpanel wiring the old bar lacked.
 *
 * Phones show Notes and Voice first, with secondary sources behind a labelled menu.
 * The active secondary source remains a real, selected tab. Larger screens keep all tabs.
 * Arrow keys move through visible enabled tabs; no duplicate tab or panel IDs are rendered.
 */
export function CaptureTabs({
  mode,
  onChange,
  disabled = false,
  showCloud = false,
  showImports = false,
}: {
  mode: CaptureTab;
  onChange: (mode: CaptureTab) => void;
  /** A job is in flight — switching would lose it. */
  disabled?: boolean;
  /** The Drive & OneDrive tab — only while the cloud-notes surface is live for this viewer. */
  showCloud?: boolean;
  /** The Imports tab — only while the `page.imports` surface is live for this viewer. */
  showImports?: boolean;
}) {
  return (
    <div className="space-y-2">
    <div
      role="tablist"
      aria-label="Capture mode"
      className="grid w-full grid-cols-2 gap-1 rounded-lg bg-muted p-[3px] sm:inline-flex sm:w-auto"
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')).filter((tab) => !tab.disabled && tab.getClientRects().length > 0);
        const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        event.preventDefault();
        tabs[next]?.focus();
        tabs[next]?.click();
      }}
    >
      {CAPTURE_MODES.filter((m) => (showCloud || m.id !== "cloud") && (showImports || m.id !== "imports")).map((m) => (
        <ModeTab
          key={m.id}
          id={captureTabId(m.id)}
          controls={capturePanelId(m.id)}
          active={mode === m.id}
          disabled={disabled}
          onClick={() => onChange(m.id)}
          icon={m.icon}
          className={m.id !== "messy" && m.id !== "voice" ? mode === m.id ? "col-span-2 sm:col-auto" : "hidden sm:block" : undefined}
        >
          {m.label}
        </ModeTab>
      ))}
    </div>
    <div className="sm:hidden">
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button type="button" variant="outline" className="min-h-11 w-full" disabled={disabled} />}>More sources</DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-56">
          {CAPTURE_MODES.filter((m) => m.id !== "messy" && m.id !== "voice" && (showCloud || m.id !== "cloud") && (showImports || m.id !== "imports")).map((source) => (
            <DropdownMenuItem key={source.id} onClick={() => onChange(source.id)}>{source.label}</DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    </div>
  );
}

/**
 * The tab bar on `/capture?mode=imports`, where the capture flow is not mounted: any other
 * tab navigates back to it, opened on that mode.
 */
export function ImportsTabBar({ showCloud = false }: { showCloud?: boolean }) {
  const router = useRouter();
  const blurb = CAPTURE_MODES.find((m) => m.id === "imports")?.blurb;
  return (
    <div className="space-y-2">
      <CaptureTabs
        mode="imports"
        showImports
        showCloud={showCloud}
        onChange={(next) => {
          if (next !== "imports") router.push(`/capture?mode=${next}`);
        }}
      />
      {blurb && <p className="text-sm text-muted-foreground">{blurb}</p>}
    </div>
  );
}

function ModeTab({
  id,
  controls,
  active,
  onClick,
  disabled = false,
  icon: Icon,
  children,
  className,
}: {
  icon: LucideIcon;
  id: string;
  controls: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-controls={controls}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      disabled={disabled && !active}
      onClick={onClick}
      className={cn(
        "relative min-h-11 flex-1 whitespace-nowrap rounded-md px-1.5 py-1.5 text-sm font-medium transition-colors sm:min-h-0 sm:flex-none sm:px-4",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground",
        className
      )}
    >
      {active && (
        <motion.span
          layoutId="capture-mode-pill"
          className="absolute inset-0 rounded-md bg-background shadow-sm"
          transition={SPRING_PILL}
        />
      )}
      <span className="relative z-10 inline-flex items-center justify-center gap-1.5">
        <Icon aria-hidden className="size-3.5 opacity-70" />
        {children}
      </span>
    </button>
  );
}
