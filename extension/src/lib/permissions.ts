/**
 * Site access.
 *
 * The popup could rely on `activeTab`: clicking the toolbar icon *is* the
 * granting gesture, so a popup always opens with permission to read the tab it
 * opened over. A side panel can't. When the action's job is to open the panel,
 * Chrome doesn't fire the action and doesn't grant `activeTab` — so the panel
 * opens able to see that a tab exists and nothing else.
 *
 * The way through is an explicit, revocable host permission requested from a
 * button in the panel. These origins are already declared under
 * `optional_host_permissions`, so asking adds no install-time warning — the
 * user meets the request at the moment it buys them something, which is a
 * better trade than a scary install dialog for a permission whose point they
 * haven't seen yet.
 */

/** The sites Orbit knows how to read deeply. */
export const KNOWN_SITES = [
  { origin: "https://*.linkedin.com/*", label: "LinkedIn" },
  { origin: "https://x.com/*", label: "X" },
  { origin: "https://twitter.com/*", label: "Twitter" },
  { origin: "https://mail.google.com/*", label: "Gmail" },
] as const;

export const KNOWN_ORIGINS: string[] = KNOWN_SITES.map((site) => site.origin);

export async function grantedOrigins(): Promise<string[]> {
  try {
    return (await chrome.permissions.getAll()).origins ?? [];
  } catch {
    return [];
  }
}

export async function hasAnySitePermission(): Promise<boolean> {
  const granted = await grantedOrigins();
  return granted.some((origin) => KNOWN_ORIGINS.includes(origin));
}

/**
 * MUST be called synchronously from a click handler — Chrome rejects a
 * permission request not tied to a user gesture, and any `await` beforehand
 * loses the gesture.
 */
export function requestSites(origins: string[]): Promise<boolean> {
  return chrome.permissions.request({ origins }).catch(() => false);
}

export function revokeSites(origins: string[]): Promise<boolean> {
  return chrome.permissions.remove({ origins }).catch(() => false);
}
