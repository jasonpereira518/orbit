/**
 * Which accounts to ask someone to connect, and in what order.
 *
 * Every user used to see the same cards. The one thing Orbit knows about a person before they
 * connect anything is the address they signed up with, and that is a strong hint about where
 * their contacts and calendar live: a gmail.com address is nearly always Google, an outlook.com
 * or hotmail.com one Microsoft, an icloud.com one Apple. So the matching provider goes first
 * and is what onboarding preselects; the rest follow in a fixed order so the list never
 * reshuffles between visits.
 *
 * Pure on purpose — no database, no statuses lookup — so the onboarding step and the
 * dashboard's "connect what you use" card can both call it with whatever they already loaded,
 * and so it can be tested without either.
 *
 * What it deliberately does NOT do: guess for a work address. `jane@acme.com` could be Google
 * Workspace or Microsoft 365, and telling them apart needs an MX lookup this module has no
 * business making. Such an address gets the default order and no "we think" claim.
 */

/** The accounts that sync continuously once connected. LinkedIn is a file export, listed apart. */
export type SuggestableProvider = "google" | "microsoft" | "apple";

export type SuggestionReason =
  /** The sign-up address is on this provider's own domain. */
  | "email_domain"
  /** No signal either way; the fixed default order. */
  | "default";

export type IntegrationSuggestion = {
  provider: SuggestableProvider;
  reason: SuggestionReason;
};

export type ConnectedProviders = Partial<Record<SuggestableProvider, boolean>>;

/** Consumer mail domains and the provider that owns the address book behind each. */
const DOMAIN_PROVIDER: Record<string, SuggestableProvider> = {
  "gmail.com": "google",
  "googlemail.com": "google",
  "outlook.com": "microsoft",
  "hotmail.com": "microsoft",
  "live.com": "microsoft",
  "msn.com": "microsoft",
  "icloud.com": "apple",
  "me.com": "apple",
  "mac.com": "apple",
};

/** Fixed, and Google first: it is the one provider that already syncs contacts and calendar. */
const DEFAULT_ORDER: readonly SuggestableProvider[] = ["google", "microsoft", "apple"];

/** The provider an address points at, or null for anything else (work and custom domains). */
export function providerForEmail(email: string | null | undefined): SuggestableProvider | null {
  const at = email?.lastIndexOf("@") ?? -1;
  if (!email || at < 0) return null;
  return DOMAIN_PROVIDER[email.slice(at + 1).trim().toLowerCase()] ?? null;
}

/**
 * The accounts still worth connecting, best first. Already-connected providers are left out,
 * so an empty list means there is nothing left to ask for.
 */
export function suggestIntegrations(input: {
  email: string | null | undefined;
  connected?: ConnectedProviders;
}): IntegrationSuggestion[] {
  const preferred = providerForEmail(input.email);
  const connected = input.connected ?? {};

  const ordered = preferred
    ? [preferred, ...DEFAULT_ORDER.filter((p) => p !== preferred)]
    : [...DEFAULT_ORDER];

  return ordered
    .filter((provider) => !connected[provider])
    .map((provider) => ({
      provider,
      reason: provider === preferred ? ("email_domain" as const) : ("default" as const),
    }));
}
