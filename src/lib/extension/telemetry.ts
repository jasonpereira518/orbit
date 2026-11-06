/**
 * Product events for the browser extension: install, action and uninstall.
 *
 * Before this the extension left one overwritten `extension_usage` row per user: no install,
 * no first use, no version, no site (audit D10). What is recorded now is deliberately thin:
 * a validated version, the browser family, an action name from a closed list, the site the
 * page adapter reported, and whether it worked. Never the page, a name, a URL or a note.
 *
 * Telemetry about a request that is already being answered, so every function here swallows
 * its own failure (a schema error throws in development by design) and none awaits anything.
 */
import { deterministicEventId } from "@/lib/product-event-ids";
import { track } from "@/lib/product-events";
import { reportError } from "@/lib/report-error";

/** The header the extension sends on every request, e.g. `1.1.0`. */
export const EXTENSION_VERSION_HEADER = "x-orbit-extension-version";
/** Sent as `1` on the first `/me` after the extension was installed, and only then. */
export const EXTENSION_INSTALL_HEADER = "x-orbit-install";

/** `1.1.0`: three numeric parts, nothing else. Pre-release suffixes are rejected, not trimmed. */
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

export function isExtensionVersion(value: unknown): value is string {
  return typeof value === "string" && SEMVER.test(value);
}

/** The build that made this request, or null when the header is absent or not a plain version. */
export function extensionVersionFrom(headers: Headers): string | null {
  const raw = headers.get(EXTENSION_VERSION_HEADER)?.trim();
  return isExtensionVersion(raw) ? raw : null;
}

export type ExtensionBrowser = "chrome" | "edge" | "brave" | "arc" | "other";

/**
 * The browser family from the User-Agent. Brave and Arc present as Chrome by design, so they
 * cannot be told apart and count as `chrome`; the enum keeps their names for the day a signal
 * exists. Anything that is not Chromium-shaped is `other`.
 */
export function browserFrom(userAgent: string | null | undefined): ExtensionBrowser {
  const ua = userAgent ?? "";
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return "edge";
  if (/\bOPR\/|\bOpera\b|\bFirefox\//.test(ua)) return "other";
  if (/\bChrome\//.test(ua)) return "chrome";
  return "other";
}

export type ExtensionAction =
  | "save_person"
  | "log_interaction"
  | "open_profile"
  | "event_roster"
  | "starters"
  | "schedule_follow_up"
  | "save_activity";

export type ExtensionEventSite = "linkedin" | "gmail" | "luma" | "partiful" | "other";

/** The page adapter's site (`PageSite`) as the event's site enum; X and generic pages are `other`. */
export function eventSiteFrom(site: string | null | undefined): ExtensionEventSite {
  return site === "linkedin" || site === "gmail" || site === "luma" || site === "partiful" ? site : "other";
}

/**
 * The first authenticated request after install. The event id is one per account, so a
 * reinstall, a second browser or a retry cannot count the same person twice; "installs" is
 * therefore people who ever installed, not browsers.
 */
export function trackExtensionInstalled(input: { userId: string; version: string | null; userAgent: string | null }): void {
  if (!input.version) return; // The schema requires a version; an unversioned install is not recorded.
  try {
    track(
      "extension_installed",
      { version: input.version, browser: browserFrom(input.userAgent) },
      {
        userId: input.userId,
        surface: "extension",
        id: deterministicEventId("extension_installed", input.userId),
      }
    );
  } catch (err) {
    reportError(err, { where: "extension.track_installed", level: "warning" });
  }
}

export function trackExtensionAction(input: {
  userId: string;
  action: ExtensionAction;
  site: ExtensionEventSite;
  ok: boolean;
}): void {
  try {
    track(
      "extension_action",
      { action: input.action, site: input.site, ok: input.ok },
      { userId: input.userId, surface: "extension" }
    );
  } catch (err) {
    reportError(err, { where: "extension.track_action", level: "warning" });
  }
}

/** The uninstall page's visit. No user (there is no session), no IP, no version beyond the validated one. */
export function trackExtensionUninstalled(version: string): void {
  try {
    track("extension_uninstalled", { version }, { surface: "extension" });
  } catch (err) {
    reportError(err, { where: "extension.track_uninstalled", level: "warning" });
  }
}
