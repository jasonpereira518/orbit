/**
 * The unit a user can choose to delete, and the unit `purgeUserData` deletes in.
 *
 * Pure metadata, in a file of its own with no `@/db` import, because the settings dialog is
 * a client component and anything that reaches `@/db` fails the build with a `node:fs`
 * chunking error naming neither file. The statements themselves live in `@/lib/user-data`,
 * keyed by the ids below.
 *
 * ORDER IS LOAD-BEARING — `purgeUserData` runs the steps in this order. Several foreign keys
 * are `on delete set null` rather than `cascade`, so a step placed after the thing it points
 * at would rewrite every one of its rows on the way to deleting them: `suggested_reminders`
 * before `reminders` and `contacts`, `event_attendees` before `contacts`,
 * `recruiter_messages` before `user_recruiter_links`.
 */
export type DataCategory =
  | "insights"
  | "notes"
  | "reminders"
  | "imports"
  | "connections"
  | "events"
  | "goals"
  | "chat"
  | "recruiters"
  | "api"
  | "activity"
  | "feedback"
  | "outreach"
  | "contacts"
  | "tags"
  | "preferences";

export type DataCategoryMeta = {
  id: DataCategory;
  /** Checkbox label. */
  label: string;
  /** One line under the label, saying what actually goes. */
  description: string;
  /**
   * Categories the database takes with this one whether the user asked or not — every entry
   * here is a real `on delete cascade`, not a tidiness rule. The dialog ticks and locks them
   * so the boxes match what the delete will actually do, and `expandCategories` applies the
   * same closure server-side so a hand-written request cannot be exceeded silently either.
   */
  implies?: DataCategory[];
};

export const DATA_CATEGORY_META: readonly DataCategoryMeta[] = [
  {
    id: "insights",
    label: "AI suggestions and search index",
    description:
      "Suggested edits, the closeness snapshot, the embeddings behind search and chat, and AI answers Orbit saved to reuse. Orbit rebuilds these from whatever contacts remain.",
  },
  {
    id: "notes",
    label: "Interactions and notes",
    description:
      "Every logged conversation, meeting and note — the raw pasted text, captured photos, meeting recordings and transcripts, and any capture still mid-review — plus the action items and mentions it produced.",
  },
  {
    id: "reminders",
    label: "Reminders and follow-ups",
    description:
      "Scheduled follow-ups, reminder lists, and the follow-ups Orbit suggested but you never accepted.",
  },
  {
    id: "imports",
    label: "Import history",
    description:
      "The record of every CSV, LinkedIn archive and mailbox scan you ran, including any that stalled part-way. Contacts they created stay.",
  },
  {
    id: "connections",
    label: "Connected accounts",
    description:
      "Gmail, Outlook, calendar subscriptions and event-provider tokens. Orbit stops syncing and you would reconnect from scratch.",
  },
  {
    id: "events",
    label: "Events and attendees",
    description:
      "Events you tracked, their attendee rosters — names, emails and employers of people you met — and the companies you linked to each one.",
  },
  {
    id: "goals",
    label: "Networking goals",
    description: "The goals you set for yourself, used to steer suggestions.",
  },
  {
    id: "chat",
    label: "Chat history",
    description: "Every thread and message in Orbit chat, including what you asked.",
  },
  {
    id: "recruiters",
    label: "Recruiter links and messages",
    description:
      "Recruiters you linked yourself to, your ratings of them, your drafts and sent messages, and the Gmail and Outlook scans' record of how far they have read. The shared recruiter directory itself stays.",
  },
  {
    id: "api",
    label: "API keys and webhooks",
    description:
      "Personal API keys, webhook endpoints and their delivery log. Anything built against them stops working immediately.",
  },
  {
    id: "activity",
    label: "Usage and diagnostics",
    description:
      "Feature-usage counters, extension rate-limit windows, the errors and gated-feature prompts Orbit recorded against your account, any queued upgrade celebration, and the identifying link on your page-view history (the visit counts themselves stay, anonymous).",
  },
  {
    id: "feedback",
    label: "Feedback you sent",
    description:
      "Your feedback and bug reports, with their screenshots. Nobody at Orbit can read them back afterwards.",
  },
  {
    id: "outreach",
    label: "Outreach campaigns",
    description:
      "Campaigns, their prospect lists, and the emails and texts sent from them.",
  },
  {
    id: "contacts",
    label: "Contacts and companies",
    description:
      "Everyone in your network, with their profiles, work history and company records — plus the merge history and duplicate-matching records behind them, and any companies you've marked as a target to work at.",
    // Not a tidiness rule — `interactions`, `reminders`, `contact_embeddings` and
    // `contact_tags` are all `on delete cascade` from `contacts`, so the database removes
    // them whether or not the box is ticked.
    implies: ["notes", "reminders", "insights"],
  },
  {
    id: "tags",
    label: "Tags",
    description:
      "The tag vocabulary itself. Deleting contacts already unties them; this removes the names too.",
  },
  {
    id: "preferences",
    label: "Preferences and onboarding state",
    description:
      "Onboarding progress, dismissed prompts, social links and the calendar feed URL. Your plan, billing, theme and provider API keys are kept.",
  },
] as const;

export const DATA_CATEGORY_IDS: readonly DataCategory[] = DATA_CATEGORY_META.map(
  (c) => c.id
);

/** The transitive closure of `implies` — what ticking these boxes actually deletes. */
export function expandCategories(
  picked: readonly DataCategory[]
): Set<DataCategory> {
  const out = new Set<DataCategory>();
  const visit = (id: DataCategory) => {
    if (out.has(id)) return;
    out.add(id);
    DATA_CATEGORY_META.find((c) => c.id === id)?.implies?.forEach(visit);
  };
  picked.forEach(visit);
  return out;
}

/**
 * The categories a delete would take that the user did not tick — the cascade's own
 * additions. The dialog renders these ticked and disabled.
 */
export function lockedByImplication(
  picked: readonly DataCategory[]
): Set<DataCategory> {
  const out = expandCategories(picked);
  for (const id of picked) out.delete(id);
  return out;
}

/** A unit of `purgeUserData`: a category, or the full-purge-only billing anonymisation. */
export type PurgeStepKey = DataCategory | "billing";

/** Attempts (the first run plus nightly resumes) before a purge run is marked failed. */
export const PURGE_MAX_ATTEMPTS = 5;

export function isDataCategory(value: string): value is DataCategory {
  return (DATA_CATEGORY_IDS as readonly string[]).includes(value);
}

/**
 * The ordered steps for an already-expanded selection. `preferences` (the `user_settings`
 * reset) always runs LAST, after billing, exactly as `purgeUserData` always has — the
 * settings row is what every other step's bookkeeping hangs off.
 */
export function planPurgeSteps(
  categories: readonly string[],
  fullPurge: boolean
): PurgeStepKey[] {
  const selected = new Set(categories);
  const steps: PurgeStepKey[] = DATA_CATEGORY_META.map((c) => c.id).filter(
    (id) => id !== "preferences" && selected.has(id)
  );
  if (fullPurge) steps.push("billing");
  if (selected.has("preferences")) steps.push("preferences");
  return steps;
}

export type DisconnectProvider = "gmail" | "outlook";

/**
 * What "Also delete what Orbit imported from this account" deletes, as whole categories
 * from the registry above, so the dialog can show each one's own label and description.
 * Only categories an account actually fills and that stay within it: Gmail and Outlook both
 * feed the recruiter scan. Neither offers `contacts` — that category is every contact, not
 * "the ones this account imported".
 */
export const DISCONNECT_DELETE_CATEGORIES: Readonly<
  Record<DisconnectProvider, readonly DataCategory[]>
> = {
  gmail: ["recruiters"],
  outlook: ["recruiters"],
};

/** Where a user removes Orbit's Outlook access themselves (no app-side revoke exists). */
export const MICROSOFT_ACCOUNT_URL = "https://myaccount.microsoft.com/";
