/**
 * Static FAQ shared by the `?` help sheet (sidebar + mobile "More") and
 * Settings → Help. Pure data — no React, no DB, no next imports — so it can
 * be imported from a client component without pulling in anything heavier.
 */
export const HELP_FAQ: Array<{
  q: string;
  a: string;
  href?: string;
  cta?: string;
}> = [
  {
    q: "How do I get people into Orbit?",
    a: "Connect Google Contacts or Outlook on Imports, paste notes into Capture, or add one person by hand. LinkedIn exports work too but take about a day.",
    href: "/imports",
    cta: "Open Imports",
  },
  {
    q: "Why does Orbit ask for an AI key?",
    a: "Orbit uses your own AI account to read notes, draft follow-ups, and answer questions. Your data goes to a provider you chose, and Orbit never bills you for it. Most people spend under a dollar a month.",
    href: "/settings#settings-ai",
    cta: "Add a key",
  },
  {
    q: "What does Orbit do with my data?",
    a: "Contacts stay in your account, keys are encrypted, and you can export or delete everything under Data and privacy.",
    href: "/settings#settings-data",
    cta: "Data and privacy",
  },
  {
    q: "I imported a file and nothing happened.",
    a: "Imports run in the background — check Import history at the bottom of Imports. A failed import has a Retry button.",
    href: "/imports",
    cta: "Open Imports",
  },
  {
    q: "Can I see the tour again?",
    a: "Yes — replay it any time from Settings → Help.",
    href: "/settings#settings-help",
    cta: "Open Help settings",
  },
];
