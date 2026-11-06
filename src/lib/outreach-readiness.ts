/**
 * What has to be true before an outreach send can possibly work — checked before the user
 * spends twenty minutes on a campaign, not per-message afterwards.
 *
 * Every one of these conditions was already enforced, correctly, on the send path. The
 * problem was WHEN. `sendOutreachMessage` throws "Resend API key not configured. Add one in
 * Settings." at the moment of sending, which is after the audience has been defined, the
 * search run, the drafts generated and reviewed, and the send confirmed through a
 * deliberately-scary dialog. Bulk send then reports it once per message. Nothing anywhere
 * earlier says that the campaign cannot be sent, and the default state of a fresh account —
 * no Apollo key, no Resend key — is exactly that state.
 *
 * So this is not new validation. It is the same set of facts, read before the work instead
 * of after it.
 *
 * ## Honest about what "ready" means
 *
 * A `ready` item means one specific precondition holds, never that a send will succeed: a
 * valid-looking Resend key can still be revoked, over quota, or sending from an unverified
 * domain, and none of that is visible until the API answers. The strip says what is
 * configured, which is all it can know. `blocked` is the stronger claim and is only used
 * where a send is guaranteed to fail — a missing key the send path itself refuses on, a
 * daily limit already reached, or an audience of fabricated rows that
 * `sendOutreachMessage` rejects outright.
 *
 * Pure: no database, no network. The facts are gathered by `getOutreachReadiness` in
 * `@/lib/outreach-readiness-server` and handed here.
 */
import { DAILY_SEND_LIMIT, type OutreachChannel } from "@/lib/outreach-types";

export type ReadinessStatus = "ready" | "attention" | "blocked";

export type ReadinessItem = {
  id: "prospects" | "drafting" | "email" | "sms" | "recipients" | "budget";
  label: string;
  status: ReadinessStatus;
  /** One sentence: what is true, and what it means for a send. */
  detail: string;
  fix?: { label: string; href: string };
};

export type ReadinessFacts = {
  /** A real Apollo key (personal, or the hosted one this plan is entitled to). */
  hasApolloKey: boolean;
  /** A key for whichever AI provider this account is set to. */
  hasAiKey: boolean;
  aiProvider: string;
  hasResendKey: boolean;
  /**
   * The address Resend will send FROM. `getOutreachSendConfig` falls back to
   * `outreach@orbit.local` when `RESEND_FROM_EMAIL` is unset — a syntactically valid
   * address on a domain that does not exist, which Resend rejects. A deployment in that
   * state has a configured key and still cannot send one email.
   */
  fromEmail: string;
  hasTwilio: boolean;
  sentToday: number;
  /** Present only on a campaign; omitted for the account-level strip. */
  campaign?: {
    channel: OutreachChannel;
    /** Prospects the user has actually selected to send to. */
    selected: number;
    /** Of those, how many `canAutoSend` accepts. */
    sendable: number;
  };
};

/** The one placeholder `getOutreachSendConfig` invents when no sender is configured. */
export const PLACEHOLDER_FROM_EMAIL = "outreach@orbit.local";

const OUTREACH_SETTINGS = {
  label: "Open outreach settings",
  href: "/settings#settings-outreach",
};
const AI_SETTINGS = { label: "Open AI settings", href: "/settings#settings-ai" };

/**
 * The readiness of an account, optionally narrowed to one campaign's channel.
 *
 * Channel-scoped on purpose: a campaign sending email has no reason to be told about
 * Twilio, and a strip that lists every transport a product supports is a strip people stop
 * reading. With no campaign (the index page) both transports are reported, because the
 * question there is "what could I run", not "can I send this".
 */
export function evaluateOutreachReadiness(facts: ReadinessFacts): ReadinessItem[] {
  const items: ReadinessItem[] = [];
  const channel = facts.campaign?.channel;

  // ------------------------------------------------------------------ finding people
  items.push(
    facts.hasApolloKey
      ? {
          id: "prospects",
          label: "Prospect search",
          status: "ready",
          detail: "Apollo is connected, so searches return real people.",
        }
      : {
          id: "prospects",
          label: "Prospect search",
          status: "attention",
          detail:
            "No Apollo key, so searches return demo prospects. They are examples, not people, and can never be sent to.",
          fix: OUTREACH_SETTINGS,
        }
  );

  // ------------------------------------------------------- parsing and writing, via AI
  //
  // This blocks more than drafting, which is worth stating precisely because the first
  // version of this copy got it wrong and a browser run caught it: `createCampaign` runs
  // `parseAudienceToFilters` on any non-empty audience, and that calls the model. Without a
  // key the wizard throws on step 1's Continue, so "you can still write each message by
  // hand" was false — there is no campaign to write messages in.
  items.push(
    facts.hasAiKey
      ? {
          id: "drafting",
          label: "Audience and drafts",
          status: "ready",
          detail: `${facts.aiProvider} will parse your audience and write the drafts.`,
        }
      : {
          id: "drafting",
          label: "Audience and drafts",
          status: "blocked",
          detail: `No ${facts.aiProvider} key. Campaigns cannot be created at all — turning your audience description into search filters goes through the model, as does every draft.`,
          fix: AI_SETTINGS,
        }
  );

  // -------------------------------------------------------------------- the transport
  //
  // LinkedIn is deliberately absent. `canAutoSend` refuses it for every prospect and
  // `sendOutreachMessage` throws on it — there is no automated LinkedIn send to be ready
  // for, and listing it as "blocked" would imply a key exists that would unblock it.
  if (channel !== "sms") {
    if (!facts.hasResendKey) {
      items.push({
        id: "email",
        label: "Email send",
        status: channel === "email" ? "blocked" : "attention",
        detail:
          "No Resend key, so Orbit cannot send email for you. Copy each draft or open it in your own mail app instead.",
        fix: OUTREACH_SETTINGS,
      });
    } else if (facts.fromEmail === PLACEHOLDER_FROM_EMAIL) {
      // Reported only once the key is present, so it reads as the next real blocker rather
      // than one of two simultaneous complaints about email. No fix link: this is a
      // deployment environment variable, not something the account holder can set.
      items.push({
        id: "email",
        label: "Email send",
        status: channel === "email" ? "blocked" : "attention",
        detail: `Resend is connected but this deployment has no sender address, so mail would be sent from ${PLACEHOLDER_FROM_EMAIL} and rejected.`,
      });
    } else {
      items.push({
        id: "email",
        label: "Email send",
        status: "ready",
        detail: `Resend is connected, sending from ${facts.fromEmail}.`,
      });
    }
  }

  if (channel !== "email") {
    items.push(
      facts.hasTwilio
        ? {
            id: "sms",
            label: "Text send",
            status: "ready",
            detail: "Twilio is connected with a sending number.",
          }
        : {
            id: "sms",
            label: "Text send",
            status: channel === "sms" ? "blocked" : "attention",
            detail:
              "Twilio needs an account SID, an auth token and a from number before Orbit can text for you.",
            fix: OUTREACH_SETTINGS,
          }
    );
  }

  // --------------------------------------------------------------- who can be sent to
  //
  // Campaign-only, and the item that catches the specific trap the demo fallback sets: a
  // full-looking prospect table where every row is fabricated and `sendOutreachMessage`
  // refuses all of them.
  if (facts.campaign && facts.campaign.selected > 0) {
    const { selected, sendable } = facts.campaign;
    if (sendable === 0) {
      items.push({
        id: "recipients",
        label: "Recipients",
        status: "blocked",
        detail: `None of the ${selected} selected prospect${selected === 1 ? "" : "s"} can be sent to automatically — they are demo rows, or have no address for this channel.`,
      });
    } else if (sendable < selected) {
      items.push({
        id: "recipients",
        label: "Recipients",
        status: "attention",
        detail: `${sendable} of ${selected} selected prospects can be sent to; the rest are demo rows or have no address for this channel.`,
      });
    } else {
      items.push({
        id: "recipients",
        label: "Recipients",
        status: "ready",
        detail: `All ${selected} selected prospect${selected === 1 ? "" : "s"} have a usable address.`,
      });
    }
  }

  // -------------------------------------------------------------------- today's budget
  const remaining = Math.max(0, DAILY_SEND_LIMIT - facts.sentToday);
  items.push({
    id: "budget",
    label: "Daily limit",
    status: remaining === 0 ? "blocked" : remaining <= DAILY_SEND_LIMIT * 0.2 ? "attention" : "ready",
    detail:
      remaining === 0
        ? `You have used all ${DAILY_SEND_LIMIT} sends for today. The limit resets at midnight.`
        : `${remaining} of ${DAILY_SEND_LIMIT} sends left today.`,
  });

  return items;
}

/** The worst status present — what the strip's own headline reports. */
export function overallReadiness(items: ReadinessItem[]): ReadinessStatus {
  if (items.some((i) => i.status === "blocked")) return "blocked";
  if (items.some((i) => i.status === "attention")) return "attention";
  return "ready";
}

/**
 * One line for the strip header, stating the consequence rather than a count.
 *
 * "Blocked", not "sending is blocked": the blockers do not all sit at the send step. A
 * missing AI key stops a campaign being created in the first place, so naming sending
 * specifically would point at the wrong end of the funnel.
 */
export function readinessHeadline(items: ReadinessItem[]): string {
  const blocked = items.filter((i) => i.status === "blocked");
  if (blocked.length > 0) {
    return blocked.length === 1
      ? `Blocked: ${blocked[0].label.toLowerCase()}`
      : `Blocked by ${blocked.length} things`;
  }
  const attention = items.filter((i) => i.status === "attention");
  if (attention.length > 0) {
    return attention.length === 1
      ? `Ready to send, with one caveat`
      : `Ready to send, with ${attention.length} caveats`;
  }
  return "Ready to send";
}
