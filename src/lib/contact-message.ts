/**
 * Shape of a /contact submission, shared by the form and the server action.
 *
 * Deliberately not inside `src/actions/contact.ts`: a "use server" module may
 * only export async functions, so constants and types the form needs have to
 * live somewhere the client can import them from.
 */
import { z } from "zod";

export const CONTACT_TOPICS = [
  { value: "bug", label: "Something is broken" },
  { value: "idea", label: "Orbit should do X" },
  { value: "privacy", label: "A privacy or data question" },
  { value: "other", label: "Something else" },
] as const;

export type ContactTopic = (typeof CONTACT_TOPICS)[number]["value"];

const TOPIC_VALUES = CONTACT_TOPICS.map((topic) => topic.value) as [
  ContactTopic,
  ...ContactTopic[],
];

export const TOPIC_LABELS = Object.fromEntries(
  CONTACT_TOPICS.map((topic) => [topic.value, topic.label])
) as Record<ContactTopic, string>;

export const MESSAGE_MAX = 2000;
export const MESSAGE_MIN = 20;

/** A bot fills a form faster than a person can read it. */
export const MIN_FILL_MS = 2500;

export const contactSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Who should I reply to?")
    .max(80, "That name is longer than this field allows."),
  email: z.email("That address doesn't look right.").max(160),
  topic: z.enum(TOPIC_VALUES),
  message: z
    .string()
    .trim()
    .min(
      MESSAGE_MIN,
      `A little more detail helps — ${MESSAGE_MIN} characters minimum.`
    )
    .max(MESSAGE_MAX, `Please keep it under ${MESSAGE_MAX} characters.`),
  /** Honeypot. Hidden from people, irresistible to form-filling bots. */
  website: z.string().max(0),
  /** Milliseconds between the form rendering and this submission. */
  elapsedMs: z.number().int().nonnegative(),
});

export type ContactInput = z.input<typeof contactSchema>;

export type ContactResult =
  | { ok: true }
  | {
      ok: false;
      message: string;
      fieldErrors?: Partial<Record<string, string>>;
    };
