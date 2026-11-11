"use client";

import { createContext, useContext, useId } from "react";
import { cn } from "@/lib/utils";

/**
 * Where a settings section is being drawn.
 *
 * `card` is the settings page itself: every section is its own bordered card. `panel` is the
 * Integrations dialog, which already supplies the chrome — a card inside a dialog panel reads
 * as a box in a box — so the same components drop their border and keep their heading. The
 * section components never need to know which one they are in.
 */
type SettingsSurface = "card" | "panel";

const SettingsSurfaceContext = createContext<SettingsSurface>("card");

export function SettingsSurfaceProvider({
  surface,
  children,
}: {
  surface: SettingsSurface;
  children: React.ReactNode;
}) {
  return (
    <SettingsSurfaceContext.Provider value={surface}>
      {children}
    </SettingsSurfaceContext.Provider>
  );
}

/**
 * The one card every settings section is drawn in.
 *
 * Headings sit one level under the page's group labels: h1 "Settings" › h2 group › h3 this
 * › h4 `SettingsRow`. In the Integrations dialog the dialog title is the h2, so the ladder
 * holds there too.
 */
export function SettingsSection({
  title,
  description,
  action,
  className,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  /** Right-aligned beside the heading — a status badge or the card's one primary action. */
  action?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  const surface = useContext(SettingsSurfaceContext);
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "space-y-4",
        surface === "card" && "rounded-2xl border border-border/70 bg-card p-6",
        className
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="text-lg font-medium text-ink">
            {title}
          </h3>
          {description ? (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * A titled block inside a section — one setting of several sharing a card, or a secondary
 * part of a single setting. Separated by a hairline, the pattern the cards already used by
 * hand for "Your socials" and "Voice transcription".
 *
 * `id` makes the row an anchor in its own right, so `/settings#settings-notifications`
 * still lands on notifications now that they share a card with the theme picker.
 *
 * `labelFor` is for a row that IS one control: the title becomes that control's `<label>`
 * (same look), and the description gets the id `${labelFor}-description` for the control's
 * `aria-describedby`.
 */
export function SettingsRow({
  id,
  title,
  description,
  labelFor,
  action,
  children,
}: {
  id?: string;
  title: string;
  description?: React.ReactNode;
  /** The id of the single control this row's title labels. */
  labelFor?: string;
  /** Controls set to the right of the title and description (they wrap under on a phone). */
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div
      id={id}
      className={cn(
        "border-t border-border/60",
        action ? "space-y-2 pt-3" : "space-y-3 pt-4",
        id && "scroll-mt-8"
      )}
    >
      <div className={action ? "flex flex-wrap items-center justify-between gap-x-4 gap-y-2" : undefined}>
        <div className={action ? "min-w-0 flex-1 basis-56" : undefined}>
        {labelFor ? (
          <label htmlFor={labelFor} className="block text-sm font-medium text-ink">
            {title}
          </label>
        ) : (
          <h4 className="text-sm font-medium text-ink">{title}</h4>
        )}
        {description ? (
          <p
            id={labelFor ? `${labelFor}-description` : undefined}
            className={cn("text-sm text-muted-foreground", action ? "mt-0.5" : "mt-1")}
          >
            {description}
          </p>
        ) : null}
        </div>
        {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </div>
  );
}
