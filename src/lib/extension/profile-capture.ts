/**
 * Work history, read off the LinkedIn page the user is looking at.
 *
 * The model reads the page's text. There are no section readers: the DOM
 * readers built for this once (PR #133) were never run against real markup and
 * came back out, and text is the one thing LinkedIn's churn can't break.
 *
 * In order, and each step exists because of a way this goes wrong:
 *
 *  1. **Is this page that contact?** Writing one person's career onto another
 *     is the worst thing this can do and the hardest to notice later. A slug
 *     disagreement stops here and asks — before any model call.
 *  2. **Read.** One model call over the fenced page text.
 *  3. **Keep only what the page says.** An entry whose organization appears
 *     nowhere in the page text is dropped, whatever the model was sure of. The
 *     prompt asks for this too; this is what makes it true.
 *  4. **Never lose what is stored.** A save replaces the career wholesale (see
 *     `saveContactProfile`), so a page that shows less than Orbit already
 *     holds — LinkedIn's "Show all 12 experiences" top five, or text cut off
 *     at the cap — writes nothing and points at the page with the full list.
 *     A details page is one section in full, so the other section, and the
 *     prose it doesn't show, are carried over rather than erased.
 *
 * Model and key checks are injectable so the smoke drives every branch with no
 * provider and no network.
 */

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { completeJson, parseAiJson, userCanUseAi } from "@/lib/ai";
import { untrustedPageBlock } from "@/lib/conversation-starters";
import { ContactNotFoundError } from "@/lib/contact-writes";
import {
  getContactProfile,
  saveContactProfile,
  type IncomingExperience,
  type StoredProfile,
} from "@/lib/contact-profile";
import { linkedinSlug } from "@/lib/duplicates";
import type {
  ProfileCaptureRequest,
  ProfileCaptureResponse,
  ProfileSection,
} from "./contract";
import { ExtensionRouteError } from "./http";
import { toSnapshotWorkHistory } from "./work-history";

export type ProfileCaptureDeps = {
  complete?: (input: { system: string; user: string }) => Promise<string>;
  canUseAi?: (userId: string) => Promise<boolean>;
};

/* -------------------------------------------------------------------------- */
/* Identity                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Only an https linkedin.com URL is read for a slug, persisted as `sourceUrl`,
 * or written onto the contact. `linkedinSlug` itself is unanchored —
 * `https://evil.example/?ref=linkedin.com/in/grace` yields "grace" — which is
 * right for matching the user's own records and wrong for a page.
 */
function isLinkedInUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && /(^|\.)linkedin\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

function pageSlug(url: string | null | undefined): string {
  if (!isLinkedInUrl(url)) return "";
  const match = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return match ? match[1].toLowerCase() : "";
}

/** `/in/<slug>` — never the details subpage, never tracking params. */
function canonicalProfileUrl(slug: string): string {
  return `https://www.linkedin.com/in/${slug}`;
}

/* -------------------------------------------------------------------------- */
/* The model's answer, clamped                                                */
/* -------------------------------------------------------------------------- */

const THIS_YEAR = new Date().getUTCFullYear();

/** Any value, including an absent key: every field below decides for itself. */
const loose = () => z.unknown().optional();

const text = (max: number) =>
  loose().transform((v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null));

const int = (min: number, max: number) =>
  loose().transform((v) => {
    const n = typeof v === "string" && v.trim() ? Number(v) : v;
    return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : null;
  });

const bool = loose().transform((v) => v === true);

/**
 * Clamps, never rejects. A model that returns a month of 13, a year as a
 * string, or one malformed entry among twelve good ones costs that one value,
 * not the capture — the old wire schema 400'd on exactly this.
 */
const entrySchema = z.object({
  kind: loose().transform((v) => (v === "education" ? "education" : "role") as "role" | "education"),
  organization: text(200),
  title: text(200),
  fieldOfStudy: text(200),
  location: text(120),
  description: text(2_000),
  startYear: int(1900, THIS_YEAR + 1),
  startMonth: int(1, 12),
  endYear: int(1900, THIS_YEAR + 10),
  endMonth: int(1, 12),
  isCurrent: bool,
});

const namedList = <T extends z.ZodRawShape>(shape: T, max: number) =>
  loose()
    .transform((v) => (Array.isArray(v) ? v.slice(0, max) : []))
    .transform((items) =>
      items.flatMap((item) => {
        const parsed = z.object(shape).safeParse(item);
        return parsed.success ? [parsed.data] : [];
      })
    );

const answerSchema = z.object({
  headline: text(300),
  about: text(8_000),
  experiences: loose()
    .transform((v) => (Array.isArray(v) ? v.slice(0, 60) : []))
    .transform((items) =>
      items.flatMap((item) => {
        const parsed = entrySchema.safeParse(item);
        return parsed.success && parsed.data.organization ? [parsed.data] : [];
      })
    ),
  skills: namedList({ name: z.string().trim().min(1).max(120) }, 60),
  certifications: namedList(
    {
      name: z.string().trim().min(1).max(200),
      issuer: text(200),
      year: int(1900, THIS_YEAR + 1),
    },
    30
  ),
  shortened: loose()
    .transform((v) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {}))
    .transform((v) => ({ experience: v.experience === true, education: v.education === true })),
});

type Answer = z.infer<typeof answerSchema>;
type Entry = Answer["experiences"][number];

const SYSTEM = [
  "You read the text of ONE person's LinkedIn page and return their work history and education as JSON.",
  'Return JSON only: {"headline","about","experiences":[{"kind","organization","title","fieldOfStudy","location","description","startYear","startMonth","endYear","endMonth","isCurrent"}],"skills":[{"name"}],"certifications":[{"name","issuer","year"}],"shortened":{"experience","education"}}.',
  "kind is 'role' for a job and 'education' for a school.",
  "organization is copied exactly as the page writes it — the employer or school name only, without '· Full-time' or similar.",
  "When several roles sit under one employer, return one entry per role, each with that employer as organization.",
  "Months are 1-12 and years are four digits. isCurrent is true only when the page says Present.",
  "shortened.experience is true when the page offers to show more experiences than it lists (e.g. 'Show all 12 experiences'); the same for education.",
  "The page is about exactly one person. Other people's names and employers — recommendations, 'People also viewed', comments — are not theirs. Ignore them.",
  "Use null for anything the page does not state. Never invent an employer, a school, a title, or a date.",
].join("\n");

/* -------------------------------------------------------------------------- */
/* Grounding                                                                  */
/* -------------------------------------------------------------------------- */

/** Case-, accent- and punctuation-blind, space-bounded — for "does the page say this". */
function groundKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function groundEntries(
  entries: Entry[],
  pageText: string
): { kept: Entry[]; dropped: number } {
  const haystack = ` ${groundKey(pageText)} `;
  const onPage = (value: string) => {
    const key = groundKey(value);
    return key.length > 0 && haystack.includes(` ${key} `);
  };
  const kept: Entry[] = [];
  let dropped = 0;
  for (const entry of entries) {
    if (!entry.organization || !onPage(entry.organization)) {
      dropped++;
      continue;
    }
    // A title the page never states is an invention too — keep the role
    // (the employer is real), lose the title.
    kept.push({
      ...entry,
      title: entry.title && onPage(entry.title) ? entry.title : null,
      fieldOfStudy: entry.fieldOfStudy && onPage(entry.fieldOfStudy) ? entry.fieldOfStudy : null,
    });
  }
  return { kept, dropped };
}

/** LinkedIn's own words when a profile lists only the first few. */
export function shortenedOnPage(pageText: string): Record<ProfileSection, boolean> {
  return {
    experience: /show all \d+ experiences?/i.test(pageText),
    education: /show all \d+ educations?/i.test(pageText),
  };
}

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

export type WorkHistoryRead =
  | { ok: true; answer: Answer; raw: Entry[]; dropped: number }
  | { ok: false; reason: "ai_error" };

/**
 * One model call and the grounding pass. Exported for the eval, which scores
 * the model's raw entries (`raw`) as well as what survives (`answer`).
 */
export async function readWorkHistory(
  complete: NonNullable<ProfileCaptureDeps["complete"]>,
  input: { name: string | null; pageBlock: string; pageText: string }
): Promise<WorkHistoryRead> {
  let content: string;
  try {
    content = await complete({
      system: SYSTEM,
      user: [input.name ? `The page belongs to: ${input.name}` : null, input.pageBlock]
        .filter(Boolean)
        .join("\n\n"),
    });
  } catch (error) {
    console.warn("[profile-capture] model call failed", error);
    return { ok: false, reason: "ai_error" };
  }
  let json: unknown;
  try {
    json = parseAiJson(content);
  } catch {
    console.warn("[profile-capture] unparseable response", { chars: content.length });
    return { ok: false, reason: "ai_error" };
  }
  // Lenient per field, strict about the shape: an answer with no experiences
  // list isn't "found nothing", it's the model failing — and saying the page
  // had no history would be a lie the user acts on.
  if (!json || typeof json !== "object" || !Array.isArray((json as { experiences?: unknown }).experiences)) {
    console.warn("[profile-capture] response has no experiences list", { chars: content.length });
    return { ok: false, reason: "ai_error" };
  }
  const parsed = answerSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "ai_error" };
  const { kept, dropped } = groundEntries(parsed.data.experiences, input.pageText);
  return {
    ok: true,
    answer: { ...parsed.data, experiences: kept },
    raw: parsed.data.experiences,
    dropped,
  };
}

/* -------------------------------------------------------------------------- */
/* Capture                                                                    */
/* -------------------------------------------------------------------------- */

const count = (list: { kind: string }[], kind: "role" | "education") =>
  list.filter((e) => e.kind === kind).length;

const KIND: Record<ProfileSection, "role" | "education"> = {
  experience: "role",
  education: "education",
};

function toIncoming(entry: Entry | StoredProfile["experiences"][number]): IncomingExperience {
  return {
    kind: entry.kind,
    organization: entry.organization ?? "",
    title: entry.title,
    fieldOfStudy: entry.fieldOfStudy,
    location: entry.location,
    description: entry.description,
    startYear: entry.startYear,
    startMonth: entry.startMonth,
    endYear: entry.endYear,
    endMonth: entry.endMonth,
    isCurrent: entry.isCurrent,
  };
}

function unionByName<T extends { name: string }>(fresh: T[], stored: T[]): T[] {
  const seen = new Set<string>();
  return [...fresh, ...stored].filter((item) => {
    const key = groundKey(item.name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function captureContactProfile(
  userId: string,
  input: ProfileCaptureRequest,
  deps: ProfileCaptureDeps = {}
): Promise<ProfileCaptureResponse> {
  const { page } = input;
  // Before touching the contact: a Gmail thread or an X profile carrying this
  // request is a client bug, not a capture.
  if (page.site !== "linkedin" || page.kind !== "person") {
    throw new ExtensionRouteError(
      "invalid_request",
      "Work history can only be read from a LinkedIn profile."
    );
  }

  const db = await getDb();
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.userId, userId), eq(contacts.id, input.contactId)),
    columns: { id: true, fullName: true, linkedinUrl: true },
  });
  // Another user's contact reads exactly like no contact.
  if (!contact) throw new ContactNotFoundError();

  // 1. Identity. Fail closed: once the contact has ANY LinkedIn on file, a
  // page with a different slug — or none at all — is a conflict, not "no
  // opinion". A contact with nothing on file is a gap, and this fills it.
  const slug = pageSlug(page.url) || pageSlug(page.sourceUrl);
  const contactSlug = linkedinSlug(contact.linkedinUrl);
  if (contactSlug && slug !== contactSlug && !input.confirmMismatch) {
    return {
      status: "conflict",
      conflict: { pageSlug: slug, contactSlug, contactName: contact.fullName },
      dropped: 0,
    };
  }

  const pageBlock = untrustedPageBlock(page);
  if (!pageBlock) return { status: "degraded", degradedReason: "no_text", dropped: 0 };
  const canUseAi = deps.canUseAi ?? userCanUseAi;
  if (!(await canUseAi(userId))) {
    return { status: "degraded", degradedReason: "no_api_key", dropped: 0 };
  }

  const complete =
    deps.complete ??
    ((request: { system: string; user: string }) =>
      completeJson(userId, {
        ...request,
        operation: "extension.profile",
        temperature: 0.1,
        maxOutputTokens: 8192,
      }));

  // 2 + 3. Read, and keep only what the page states.
  const [stored, read] = await Promise.all([
    getContactProfile(userId, contact.id),
    readWorkHistory(complete, {
      name: page.identity.name?.value ?? contact.fullName,
      pageBlock,
      pageText: page.text.blob,
    }),
  ]);
  if (!read.ok) return { status: "degraded", degradedReason: read.reason, dropped: 0 };
  const { answer, dropped } = read;
  if (dropped > 0) {
    console.warn("[profile-capture] dropped entries not on the page", { dropped });
  }

  // 4. Never lose what is stored.
  const storedEntries = stored?.experiences ?? [];
  const onPage = shortenedOnPage(page.text.blob);
  const sections: ProfileSection[] = page.section ? [page.section] : ["experience", "education"];
  const captured = page.section
    ? answer.experiences.filter((e) => e.kind === KIND[page.section!])
    : answer.experiences;

  const shortened: ProfileSection[] = [];
  for (const section of sections) {
    const kind = KIND[section];
    // A details page IS the full list; only the profile itself shortens.
    const isShort =
      !page.section && (onPage[section] || answer.shortened[section]);
    const mayHoldMore = isShort || page.text.truncated;
    if (mayHoldMore && count(captured, kind) < count(storedEntries, kind)) {
      return { status: "partial", openSection: section, dropped };
    }
    if (isShort) shortened.push(section);
  }

  if (captured.length === 0) {
    return { status: "degraded", degradedReason: "nothing_found", dropped };
  }

  // A details page replaces its own section; the other section and the prose
  // it never shows are carried over.
  const carried = page.section
    ? storedEntries.filter((e) => e.kind !== KIND[page.section!]).map(toIncoming)
    : [];
  const profileUrl = slug ? canonicalProfileUrl(slug) : null;
  const warnings = [
    ...shortened.map((s) => `${s}-shortened`),
    ...(page.text.truncated ? ["text-truncated"] : []),
    ...(dropped > 0 ? [`dropped-${dropped}`] : []),
  ];

  const result = await saveContactProfile(userId, contact.id, {
    source: "extension",
    sourceUrl: profileUrl,
    adapterVersion: page.adapterVersion,
    capturedAt: new Date(),
    warnings,
    headline: page.section ? (stored?.headline ?? null) : (answer.headline ?? stored?.headline ?? null),
    about: page.section ? (stored?.about ?? null) : (answer.about ?? stored?.about ?? null),
    // Unioned, not replaced: a profile shows its top few skills, so a capture
    // of it must not shrink a longer list stored before.
    skills: unionByName(page.section ? [] : answer.skills, stored?.skills ?? []),
    certifications: unionByName(
      page.section ? [] : answer.certifications,
      stored?.certifications ?? []
    ),
    volunteering: stored?.volunteering ?? [],
    publications: stored?.publications ?? [],
    experiences: [...captured.map(toIncoming), ...carried],
  });
  if (!result.written) {
    return { status: "degraded", degradedReason: "nothing_found", dropped };
  }

  // Filling a gap: only a contact with NO LinkedIn on file gets this page's.
  // A confirmed mismatch never rewrites the one the user already has.
  if (!contact.linkedinUrl?.trim() && profileUrl) {
    await db
      .update(contacts)
      .set({ linkedinUrl: profileUrl })
      .where(and(eq(contacts.userId, userId), eq(contacts.id, contact.id)));
  }

  return {
    status: "saved",
    dropped,
    ...(shortened.length ? { shortened } : {}),
    workHistory: toSnapshotWorkHistory(await getContactProfile(userId, contact.id)),
  };
}
