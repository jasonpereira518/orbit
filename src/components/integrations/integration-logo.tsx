import type { ReactNode } from "react";
import {
  CalendarDays,
  FileSpreadsheet,
  FileText,
  Plug,
  Smartphone,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * One logo component for every data source and connector.
 *
 * Brand marks are the official SVGs in `public/integrations/` (the same paths the settings
 * dialog has always shipped: Google's exact published colours, Microsoft's four squares,
 * LinkedIn's blue, and the AI providers). Colour marks render as an `<img>`; monochrome
 * marks (OpenAI, OpenRouter, ChatGPT) render as a CSS mask filled with `currentColor` so they
 * follow the theme.
 *
 * Product-level marks (Google Drive, Gmail, Google Calendar, Outlook, OneDrive) are NOT
 * redrawn: those keys resolve to the parent brand mark and carry the product name as their
 * label, which is what the provider's own consent screen shows. Event platforms and file
 * formats without an official asset in the repo use a neutral lucide glyph. Drop an official
 * SVG into `public/integrations/<key>.svg` and point the entry's `file` at it to upgrade one.
 */
export type IntegrationKey =
  | "google"
  | "gmail"
  | "google-calendar"
  | "google-contacts"
  | "google-drive"
  | "microsoft"
  | "outlook"
  | "outlook-calendar"
  | "onedrive"
  | "linkedin"
  | "gemini"
  | "openai"
  | "chatgpt"
  | "claude"
  | "anthropic"
  | "openrouter"
  | "eventbrite"
  | "luma"
  | "partiful"
  | "apple"
  | "ics"
  | "csv"
  | "file";

type Entry = {
  label: string;
  file?: string;
  /** Single-colour mark: render through a mask so it takes `currentColor`. */
  mono?: boolean;
  icon?: LucideIcon;
  /** Parent brand that owns the mark (for product keys). */
  parent?: IntegrationKey;
};

export const INTEGRATIONS: Record<IntegrationKey, Entry> = {
  google: { label: "Google", file: "google.svg" },
  gmail: { label: "Gmail", file: "google.svg", parent: "google" },
  "google-calendar": { label: "Google Calendar", file: "google.svg", parent: "google" },
  "google-contacts": { label: "Google Contacts", file: "google.svg", parent: "google" },
  "google-drive": { label: "Google Drive", file: "google.svg", parent: "google" },
  microsoft: { label: "Microsoft", file: "microsoft.svg" },
  outlook: { label: "Outlook", file: "microsoft.svg", parent: "microsoft" },
  "outlook-calendar": { label: "Outlook Calendar", file: "microsoft.svg", parent: "microsoft" },
  onedrive: { label: "OneDrive", file: "microsoft.svg", parent: "microsoft" },
  linkedin: { label: "LinkedIn", file: "linkedin.svg" },
  gemini: { label: "Google Gemini", file: "gemini.svg" },
  openai: { label: "OpenAI", file: "openai.svg", mono: true },
  chatgpt: { label: "ChatGPT", file: "chatgpt.svg", mono: true },
  claude: { label: "Claude", file: "claude.svg" },
  anthropic: { label: "Anthropic", file: "claude.svg", parent: "claude" },
  openrouter: { label: "OpenRouter", file: "openrouter.svg", mono: true },
  eventbrite: { label: "Eventbrite", icon: Plug },
  luma: { label: "Luma", icon: Plug },
  partiful: { label: "Partiful", icon: Plug },
  apple: { label: "Apple iCloud", icon: Smartphone },
  ics: { label: "Calendar feed", icon: CalendarDays },
  csv: { label: "Spreadsheet", icon: FileSpreadsheet },
  file: { label: "File", icon: FileText },
};

export function integrationLabel(key: IntegrationKey): string {
  return INTEGRATIONS[key].label;
}

/** Connection status copy, one place. */
export type IntegrationStatus = "connected" | "needs-reconnect" | "not-connected" | "checking";

export const INTEGRATION_STATUS_COPY: Record<IntegrationStatus, string> = {
  connected: "Connected",
  "needs-reconnect": "Needs reconnecting",
  "not-connected": "Not connected",
  checking: "Checking…",
};

const STATUS_DOT: Record<IntegrationStatus, string> = {
  connected: "bg-success",
  "needs-reconnect": "bg-warning",
  "not-connected": "bg-muted-foreground/50",
  checking: "bg-muted-foreground/50 animate-pulse",
};

const TILE = {
  sm: { tile: "size-6 rounded-md", mark: "size-3.5", icon: "size-3.5" },
  md: { tile: "size-8 rounded-lg", mark: "size-4.5", icon: "size-4" },
  lg: { tile: "size-10 rounded-lg", mark: "size-5.5", icon: "size-5" },
} as const;

export type IntegrationLogoSize = keyof typeof TILE;

/**
 * The mark in a neutral tile. `tile={false}` gives the bare mark for inline use (a source
 * chip, a select option).
 */
export function IntegrationLogo({
  provider,
  size = "md",
  tile = true,
  className,
  title,
}: {
  provider: IntegrationKey;
  size?: IntegrationLogoSize;
  tile?: boolean;
  className?: string;
  /** Accessible name; defaults to the provider label. Pass `""` when a visible label sits next to it. */
  title?: string;
}) {
  const entry = INTEGRATIONS[provider];
  const dims = TILE[size];
  const label = title ?? entry.label;
  const decorative = label === "";

  let mark: ReactNode;
  if (entry.file && entry.mono) {
    mark = (
      <span
        role={decorative ? undefined : "img"}
        aria-label={decorative ? undefined : label}
        aria-hidden={decorative || undefined}
        className={cn("inline-block bg-current text-foreground", dims.mark)}
        style={{
          maskImage: `url(/integrations/${entry.file})`,
          maskRepeat: "no-repeat",
          maskPosition: "center",
          maskSize: "contain",
          WebkitMaskImage: `url(/integrations/${entry.file})`,
          WebkitMaskRepeat: "no-repeat",
          WebkitMaskPosition: "center",
          WebkitMaskSize: "contain",
        }}
      />
    );
  } else if (entry.file) {
    mark = (
      // eslint-disable-next-line @next/next/no-img-element -- a 1 KB static SVG; next/image adds nothing here.
      <img
        src={`/integrations/${entry.file}`}
        alt={label}
        aria-hidden={decorative || undefined}
        width={24}
        height={24}
        draggable={false}
        className={cn("shrink-0 select-none", dims.mark)}
      />
    );
  } else {
    const Icon = entry.icon ?? Plug;
    mark = (
      <Icon
        aria-hidden={decorative || undefined}
        aria-label={decorative ? undefined : label}
        role={decorative ? undefined : "img"}
        className={cn("text-muted-foreground", dims.icon)}
      />
    );
  }

  if (!tile) return <span className={cn("inline-flex shrink-0 items-center justify-center", className)}>{mark}</span>;

  return (
    <span
      data-slot="integration-logo"
      className={cn(
        "inline-flex shrink-0 items-center justify-center border border-border-subtle bg-card",
        dims.tile,
        className
      )}
    >
      {mark}
    </span>
  );
}

/**
 * Logo + name (+ optional status). The row header for a connector anywhere it is listed.
 */
export function IntegrationBadge({
  provider,
  label,
  status,
  detail,
  size = "md",
  className,
}: {
  provider: IntegrationKey;
  /** Override the name (e.g. "Google Drive" on a Drive-only row). */
  label?: ReactNode;
  status?: IntegrationStatus;
  /** Secondary line ("as jason@…", "Checked 2h ago"). */
  detail?: ReactNode;
  size?: IntegrationLogoSize;
  className?: string;
}) {
  const name = label ?? INTEGRATIONS[provider].label;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2.5", className)}>
      <IntegrationLogo provider={provider} size={size} title="" />
      <span className="min-w-0">
        <span className={cn("block truncate font-medium text-ink", size === "sm" ? "text-xs" : "text-sm")}>{name}</span>
        {(status || detail) && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {status && <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[status])} />}
            <span className="truncate">
              {status ? INTEGRATION_STATUS_COPY[status] : null}
              {status && detail ? " · " : null}
              {detail}
            </span>
          </span>
        )}
      </span>
    </span>
  );
}
