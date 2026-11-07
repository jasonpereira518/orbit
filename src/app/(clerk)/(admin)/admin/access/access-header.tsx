import { AccessTabs } from "@/components/admin/admin-tabs";
import { AdminPageHeader } from "@/components/admin/primitives";
import { StealthControl } from "@/components/admin/site-access";
import type { SiteMode } from "@/lib/site-access";

/** Absolute date, spelled out. The relative label rides alongside it, not instead of it. */
export function absoluteUtc(date: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date);
}

/**
 * The header every Access tab shares: the title, the stealth switch (whether the site is open
 * is the question behind all three tabs), and the tab row.
 *
 * Takes `mode` rather than reading it, so each page fetches `getSiteMode({ fresh: true })`
 * inside its own `Promise.all` instead of waiting on it after the rest of its data.
 */
export function AccessHeader({
  mode,
  subtitle,
  actions,
}: {
  mode: SiteMode;
  subtitle: React.ReactNode;
  /** The tab's own header buttons, after the stealth switch. */
  actions?: React.ReactNode;
}) {
  return (
    <>
      <AdminPageHeader
        title="Access"
        subtitle={subtitle}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <StealthControl
              stealth={mode.stealth}
              fromConsole={mode.fromConsole}
              stealthSinceLabel={mode.stealthSince ? `${absoluteUtc(mode.stealthSince)} UTC` : null}
            />
            {actions}
          </div>
        }
      />
      <AccessTabs />
    </>
  );
}
