import { track } from "@vercel/analytics";

/**
 * The funnel event vocabulary for Vercel Web Analytics — acquisition through
 * monetization. Every property here is a bounded enum or a count, mirroring the rule
 * `redactUrlForVendor` (`@/lib/analytics-routes`) already enforces for URLs: an id, name,
 * or other per-record value must never reach Vercel. `beforeSend` in
 * `VercelTelemetry` only redacts the event URL — this module is the only place a custom
 * event's own properties are constrained, so a call site literally cannot pass a free-text
 * or identifying field for an event that doesn't declare one.
 */
export const ANALYTICS_EVENTS = {
  waitlistJoined: "Waitlist Joined",
  signupCompleted: "Signup Completed",
  onboardingCompleted: "Onboarding Completed",
  contactCaptured: "Contact Captured",
  importCompleted: "Import Completed",
  outreachMessageSent: "Outreach Message Sent",
  chatQuerySent: "Chat Query Sent",
  graphOpened: "Graph Opened",
  contactsMerged: "Contacts Merged",
  upgradeCtaClicked: "Upgrade CTA Clicked",
  subscriptionStarted: "Subscription Started",
} as const;

export type EventProps = {
  [ANALYTICS_EVENTS.waitlistJoined]: { source: "landing" | "interest_page" };
  [ANALYTICS_EVENTS.signupCompleted]: Record<string, never>;
  [ANALYTICS_EVENTS.onboardingCompleted]: {
    path: "manual" | "capture" | "import" | "mixed" | "skipped";
  };
  [ANALYTICS_EVENTS.contactCaptured]: {
    source: "messy" | "voice" | "meeting" | "scan" | "phone";
    createdCount: number;
    updatedCount: number;
  };
  [ANALYTICS_EVENTS.importCompleted]: {
    provider:
      | "connections"
      | "messages"
      | "google_contacts"
      | "outlook_contacts"
      | "contacts_file"
      | "calendar";
  };
  [ANALYTICS_EVENTS.outreachMessageSent]: { channel: "email" | "sms" | "linkedin" };
  [ANALYTICS_EVENTS.chatQuerySent]: { hasContactMentions: boolean };
  [ANALYTICS_EVENTS.graphOpened]: Record<string, never>;
  [ANALYTICS_EVENTS.contactsMerged]: Record<string, never>;
  [ANALYTICS_EVENTS.upgradeCtaClicked]: {
    surface: "pricing_cards" | "quota_notice" | "plan_settings";
  };
  [ANALYTICS_EVENTS.subscriptionStarted]: {
    plan: "orbit" | "lifetime";
    billingInterval: "month" | "year" | "lifetime";
  };
};

/** Client-side custom event. Fire-and-forget — `track()` queues onto the already-mounted `<Analytics />`. */
export function trackEvent<K extends keyof EventProps>(name: K, props: EventProps[K]): void {
  track(name, props);
}
