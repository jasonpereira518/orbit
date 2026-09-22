"use client";

import {
  BookUser,
  Bot,
  CalendarDays,
  FileSpreadsheet,
  KeyRound,
  Send,
  Sparkles,
  Users,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import type { IntegrationTabId } from "@/components/settings/sections";
import { GoogleMark, LinkedInMark, MicrosoftMark } from "@/components/settings/provider-marks";
import type { PageStatus } from "@/lib/integration-status";
import { cn } from "@/lib/utils";

const ICONS: Record<IntegrationTabId, LucideIcon> = {
  google: Users,
  microsoft: BookUser,
  linkedin: FileSpreadsheet,
  ai: Sparkles,
  assistants: Bot,
  reminders: CalendarDays,
  api: KeyRound,
  webhooks: Webhook,
  outreach: Send,
};

const MARKS: Partial<Record<IntegrationTabId, (props: { className?: string }) => React.JSX.Element>> = {
  google: GoogleMark,
  microsoft: MicrosoftMark,
  linkedin: LinkedInMark,
};

/** Decorative: every use sits beside the page's name. Accounts get their provider's mark. */
export function IntegrationIcon({ id, className }: { id: IntegrationTabId; className?: string }) {
  const Mark = MARKS[id];
  if (Mark) return <Mark className={className} />;
  const Icon = ICONS[id];
  return <Icon aria-hidden className={className} />;
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
        className={cn("size-1.5 shrink-0 animate-pulse rounded-full bg-muted-foreground/30", className)}
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
        state === "on" && "bg-primary",
        state === "partial" && "bg-warning",
        state === "off" && "bg-muted-foreground/35",
        className
      )}
    />
  );
}

export function statusText(status: PageStatus | "unknown" | undefined) {
  if (status === undefined) return "Checking…";
  if (status === "unknown") return "Couldn’t check";
  return status.detail;
}
