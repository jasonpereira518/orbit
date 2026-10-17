import { z } from "zod";
import type { ContactInput } from "@/lib/contact-writes";
import { MAX_LIST_ITEMS, MAX_TAGS, TEXT_LIMITS, cleanText, cleanTextList } from "@/lib/input/text";

/**
 * The server-side input contract for contacts.
 *
 * `ContactInput` was a bare TypeScript type shared by the contact form, the browser
 * extension, `POST /api/v1/contacts` and every importer — which means it was enforced
 * nowhere at runtime. Two consequences seen in testing:
 *
 *   - Three spaces in the name field created a permanent nameless contact. The form's
 *     `required` attribute is satisfied by whitespace and the server then trimmed it to
 *     `""`, leaving a row whose delete dialog reads "Delete ?".
 *   - A 10,000-character name made a contact *undeletable*: the confirm dialog
 *     interpolates the name into its title, which pushed the dialog's own buttons to
 *     x=116,705px. Capping lengths is what stops that class of bug at the source;
 *     clamping the rendering is a separate fix, and both are wanted.
 *
 * Two modes, because the right answer differs by caller:
 *
 *   - `strict` — the contact form, the extension, the public API. A malformed field is
 *     the user's mistake and they are standing right there, so say so.
 *   - `lenient` — importers. Checks the name and nothing else, deliberately. A LinkedIn
 *     archive is someone else's messy data, and the import engine already has a better
 *     answer for a row the database refuses: `writeWithNarrowing` isolates it and reports
 *     it in `failedRows`, where the user can see it. Silently dropping fields here would
 *     replace a visible, recoverable failure with an invisible one — so the only thing
 *     lenient mode enforces is the one defect the database cannot catch for itself, a
 *     name that is empty or whitespace.
 */

/** Generous enough for any real value, small enough to keep a name out of layout math. */
const LIMITS = {
  name: 200,
  company: 200,
  title: 200,
  location: 200,
  school: 200,
  email: 320, // RFC 5321 maximum path length
  phone: 50,
  url: 500,
  handle: 100,
} as const;

function trimmedMax(max: number) {
  return z
    .string()
    .transform((v) => v.trim())
    .refine((v) => v.length <= max, { message: `Must be ${max} characters or fewer` });
}

/** Optional free text: blank and whitespace-only both collapse to undefined. */
function optionalText(max: number) {
  return trimmedMax(max)
    .transform((v) => (v.length === 0 ? undefined : v))
    .optional();
}

/**
 * Accepts any host under linkedin.com, including regional subdomains
 * (`uk.linkedin.com`) and bare hostnames without a scheme, both of which appear in
 * real Connections.csv exports. Rejects a well-formed URL on some other host, which
 * is the actual reported bug — `https://evil.example.com/not-linkedin` saved happily
 * into the LinkedIn field.
 */
export function isLinkedInProfileUrl(url: string) {
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(
      trimmed.startsWith("http") ? trimmed : `https://${trimmed}`
    );
    const host = parsed.hostname.toLowerCase();
    return host === "linkedin.com" || host.endsWith(".linkedin.com");
  } catch {
    return /linkedin\.com\//i.test(trimmed);
  }
}

const baseShape = {
  fullName: trimmedMax(LIMITS.name).refine((v) => v.length > 0, {
    message: "Name is required",
  }),
  firstName: optionalText(LIMITS.name),
  lastName: optionalText(LIMITS.name),
  preferredName: optionalText(LIMITS.name),
  company: optionalText(LIMITS.company),
  title: optionalText(LIMITS.title),
  location: optionalText(LIMITS.location),
  school: optionalText(LIMITS.school),
  email: optionalText(LIMITS.email).refine(
    (v) => v === undefined || z.string().email().safeParse(v).success,
    { message: "That email address doesn't look right" }
  ),
  phone: optionalText(LIMITS.phone),
  linkedinUrl: optionalText(LIMITS.url).refine(
    (v) => v === undefined || isLinkedInProfileUrl(v),
    { message: "That doesn't look like a LinkedIn profile URL" }
  ),
  xHandle: optionalText(LIMITS.handle),
  website: optionalText(LIMITS.url),
};

/**
 * Caps for the free-text fields the strict schema does not own. Truncated rather than
 * refused, in BOTH modes: these are written by extraction (a capture's `notes` can be the
 * whole 100k-character corpus), importers and people alike, and a hard refusal here would
 * turn an over-long LinkedIn "About" into a failed import row. Every cap sits above what any
 * of those producers writes today and below the 1 MB at which `search_tsv` fails the save.
 */
const FREE_TEXT_CAPS: Record<string, number> = {
  notes: TEXT_LIMITS.rawNotes,
  aiSummary: TEXT_LIMITS.summary,
  howMet: TEXT_LIMITS.shortParagraph,
  metContext: 200,
  industry: 200,
  source: 100,
  cadencePhrase: 200,
};

/** Cap for any other string field: the strict schema's own caps are lower and still apply. */
const DEFAULT_FIELD_CAP = TEXT_LIMITS.shortParagraph;

/**
 * Make every string in a contact input storable (audit M-05): NUL and other control
 * characters stripped (Postgres refuses `\u0000` in a `text` column, and one in a name used
 * to fail the whole write with an opaque 500), NFC-normalised, and capped. List fields are
 * cleaned per entry and bounded in length. Runs before validation in every mode, so the
 * strict schema measures what will actually be stored.
 */
export function cleanContactFreeText<T extends Partial<ContactInput>>(input: T): T {
  const out: Record<string, unknown> = { ...input };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "string") out[k] = cleanText(v, FREE_TEXT_CAPS[k] ?? DEFAULT_FIELD_CAP);
  }
  if (Array.isArray(input.keyFacts)) out.keyFacts = cleanTextList(input.keyFacts, TEXT_LIMITS.listItem, MAX_LIST_ITEMS);
  if (Array.isArray(input.sharedInterests)) out.sharedInterests = cleanTextList(input.sharedInterests, TEXT_LIMITS.listItem, MAX_LIST_ITEMS);
  if (Array.isArray(input.opportunities)) out.opportunities = cleanTextList(input.opportunities, TEXT_LIMITS.listItem, MAX_LIST_ITEMS);
  if (Array.isArray(input.tagNames)) out.tagNames = cleanTextList(input.tagNames, TEXT_LIMITS.tag, MAX_TAGS);
  return out as T;
}

/** Validates the fields this module owns; everything else passes through untouched. */
const strictSchema = z.object(baseShape);

/** What lenient mode checks: a usable name, and nothing more. */
const nameOnlySchema = z.object({ fullName: baseShape.fullName });

export type ContactInputIssue = { field: string; message: string };

export type NormalizeResult =
  | { ok: true; value: ContactInput }
  | { ok: false; issues: ContactInputIssue[] };

/**
 * Validate and normalize a contact input.
 *
 * Fields outside the schema (tags, source, closeness, timestamps and the rest) are
 * carried through unchanged — this guards the user-supplied text, not the whole
 * write shape.
 */
export function normalizeContactInput(
  rawInput: ContactInput,
  mode: "strict" | "lenient" = "strict"
): NormalizeResult {
  const input = cleanContactFreeText(rawInput);
  const parsed = strictSchema.safeParse(input);

  if (parsed.success) {
    return { ok: true, value: { ...input, ...stripUndefined(parsed.data) } };
  }

  const issues: ContactInputIssue[] = parsed.error.issues.map((i) => ({
    field: String(i.path[0] ?? ""),
    message: i.message,
  }));

  if (mode === "strict") return { ok: false, issues };

  // Lenient: the name is the only gate. Everything else is left exactly as the importer
  // supplied it, so a value the database ultimately refuses still travels the existing
  // narrowing path and lands in `failedRows` rather than vanishing.
  const name = nameOnlySchema.safeParse(input);
  if (!name.success) {
    return {
      ok: false,
      issues: name.error.issues.map((i) => ({
        field: String(i.path[0] ?? ""),
        message: i.message,
      })),
    };
  }

  return { ok: true, value: { ...input, fullName: name.data.fullName } };
}

/**
 * Throwing form, for callers that are a single user action rather than a batch.
 * The message is user-facing — it reaches the contact form's error toast.
 */
export function parseContactInput(input: ContactInput): ContactInput {
  const result = normalizeContactInput(input, "strict");
  if (result.ok) return result.value;
  throw new Error(result.issues[0]?.message || "That contact isn't valid.");
}

/**
 * Optional keys set to `undefined` must not overwrite a caller's own value with
 * `undefined` during the spread — drop them so the original survives.
 */
function stripUndefined<T extends Record<string, unknown>>(obj: T) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Partial form, for edits. Only the fields actually present are checked, so a patch
 * that touches one field cannot be rejected by another it never sends.
 */
export function parseContactPatch(
  rawInput: Partial<ContactInput>
): Partial<ContactInput> {
  const input = cleanContactFreeText(rawInput);
  const partial = z.object(baseShape).partial();
  const parsed = partial.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues[0]?.message || "That contact isn't valid."
    );
  }
  // An explicitly-cleared field arrives as "" and normalizes to undefined, which in a
  // patch must still mean "clear it" rather than "leave it alone".
  //
  // The test is "present AND not undefined", not merely "present". A caller that spells out
  // every field and passes `undefined` for the ones it has nothing to say about — which is
  // ordinary TypeScript, and what `{ fullName: parsed.name || undefined }` produces — means
  // "leave alone", not "clear". Keying on `k in input` alone turned those into explicit
  // nulls: `note-batch-save.ts` writes a NULL into the NOT NULL `full_name` column whenever
  // a pasted note merges into an existing contact without a name in it, and the extension's
  // merge save (which also spells out every field) blanked company, title and email for any
  // field the scraped page happened not to carry.
  const out: Partial<ContactInput> = { ...input };
  const raw = input as Record<string, unknown>;
  for (const [k, v] of Object.entries(parsed.data)) {
    if (k in input && raw[k] !== undefined) {
      (out as Record<string, unknown>)[k] = v ?? null;
    }
  }
  return out;
}
