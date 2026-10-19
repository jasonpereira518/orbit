"use client";

import {
  CalendarDays,
  Cpu,
  KeyRound,
  Send,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import type { IntegrationTabId } from "@/components/settings/sections";
import {
  INTEGRATION_STATUS_COPY,
  IntegrationLogo,
  type IntegrationKey,
  type IntegrationLogoSize,
} from "@/components/integrations/integration-logo";
import type { PageStatus } from "@/lib/integration-status";
import { cn } from "@/lib/utils";

/** Pages that are a brand: their tile is the brand mark through `IntegrationLogo`. */
const BRANDS: Partial<Record<IntegrationTabId, IntegrationKey>> = {
  google: "google",
  microsoft: "microsoft",
  linkedin: "linkedin",
};

/** The one page that is two brands at once. */
const ASSISTANT_BRANDS: readonly IntegrationKey[] = ["claude", "chatgpt"];

const ICONS: Partial<Record<IntegrationTabId, LucideIcon>> = {
  ai: Cpu,
  reminders: CalendarDays,
  api: KeyRound,
  webhooks: Webhook,
  outreach: Send,
};

const TILE: Record<IntegrationLogoSize, { tile: string; icon: string }> = {
  sm: { tile: "size-6 rounded-md", icon: "size-3.5" },
  md: { tile: "size-8 rounded-lg", icon: "size-4" },
  lg: { tile: "size-10 rounded-lg", icon: "size-5" },
};

/**
 * Decorative: every use sits beside the page's name. Accounts and assistants get their
 * brand mark in `IntegrationLogo`'s neutral tile; the rest get a lucide glyph in the same
 * tile, so a nav of mixed pages lines up.
 */
export function IntegrationIcon({
  id,
  size = "md",
  className,
}: {
  id: IntegrationTabId;
  size?: IntegrationLogoSize;
  className?: string;
}) {
  const brand = BRANDS[id];
  if (brand) return <IntegrationLogo provider={brand} size={size} title="" className={className} />;

  const dims = TILE[size];
  if (id === "assistants") {
    return (
      <span
        aria-hidden
        className={cn(
          "inline-flex shrink-0 items-center justify-center gap-0.5 border border-border-subtle bg-card",
          dims.tile,
          className
        )}
      >
        {ASSISTANT_BRANDS.map((key) => (
          <IntegrationLogo
            key={key}
            provider={key}
            size="sm"
            tile={false}
            title=""
            className={size === "sm" ? "[&>*]:size-2.5" : "[&>*]:size-3"}
          />
        ))}
      </span>
    );
  }

  const Icon = ICONS[id] ?? Cpu;
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center border border-border-subtle bg-card text-muted-foreground",
        dims.tile,
        className
      )}
    >
      <Icon className={dims.icon} />
    </span>
  );
}

/** `undefined` is still loading; `none` is a page with nothing to be on or off. */
export function StatusDot({
  status,
  className,
}: {
  status: PageStatus | "unknown" | undefined;
  className?: string;
}) {
  if (status === undefined) {
    return (
      <span
        aria-hidden
        className={cn("size-1.5 shrink-0 animate-pulse rounded-full bg-muted-foreground/50", className)}
      />
    );
  }
  if (status !== "unknown" && status.state === "none") return null;
  const state = status === "unknown" ? "off" : status.state;
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        state === "on" && "bg-success",
        state === "partial" && "bg-warning",
        state === "off" && "bg-muted-foreground/50",
        className
      )}
    />
  );
}

export function statusText(status: PageStatus | "unknown" | undefined) {
  if (status === undefined) return INTEGRATION_STATUS_COPY.checking;
  if (status === "unknown") return "Couldn’t check";
  return status.detail;
}
