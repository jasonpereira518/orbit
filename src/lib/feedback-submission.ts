/**
 * Validating and storing what a user sends through the feedback widget.
 *
 * Split from `src/actions/feedback.ts` for the same reason `admin-operations.ts` is split
 * from `actions/admin.ts`: the safety-critical part of this feature is the validation, and
 * a `"use server"` module can only export async functions and cannot be exercised outside a
 * request. Everything here is a plain function, so `scripts/smoke-feedback-image.ts` can
 * hammer it without a database or a server.
 *
 * Deliberately NOT added to `src/lib/feedback.ts`. That module is the read/analytics side,
 * and its one writer (`recordFeedback`) swallows every error on purpose — the right call
 * for an unprompted PMF answer nobody is watching, and the wrong one for a form with a
 * submit button.
 */

import { put } from "@vercel/blob";
import { z } from "zod";
import { getDb } from "@/db";
import { feedback, feedbackScreenshots } from "@/db/schema";
import { hasBlobStorage } from "@/lib/contact-avatar";

/**
 * Which part of Orbit a report is about. Offered by the form (prefilled from the route)
 * and validated here.
 *
 * `feedback.area` is plain text with no CHECK, so this list can grow without DDL or a
 * `SCHEMA_VERSION` bump — but it is still a closed set at the boundary, because an
 * open-ended string would turn the console's filter into a free-text search.
 */
export const FEEDBACK_AREAS = [
  "dashboard",
  "contacts",
  "capture",
  "import",
  "reminders",
  "chat",
  "graph",
  "outreach",
  "knowledge",
  "settings",
  "onboarding",
  "other",
] as const;
export type FeedbackArea = (typeof FEEDBACK_AREAS)[number];

/** What kind of remark it is. Orthogonal to the area — what happened vs. where. */
export const FEEDBACK_CATEGORIES = ["bug", "idea", "confusing", "praise"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

/** Before, the error, after. A fourth shot has never told anyone anything new. */
export const MAX_SCREENSHOTS = 3;

/** Per shot, measured on the DECODED bytes — not on the base64 string. */
export const MAX_SCREENSHOT_BYTES = 500_000;

/**
 * Ceiling on one submission, so three maximal shots cannot land as one request.
 *
 * ~2 MB once base64 inflates it, which matters: Vercel's function request-body limit is
 * ~4.5 MB and `experimental.serverActions.bodySizeLimit` does NOT raise it. The 32 MB in
 * `next.config.ts` is a local-dev ceiling, not a platform one.
 */
export const MAX_SUBMISSION_BYTES = 1_500_000;

/** A caption for one screenshot, not an essay. */
export const MAX_SHOT_NOTE = 500;

/** Long enough to be a sentence, short enough not to be a document. */
export const MAX_FEEDBACK_TEXT = 4000;

/** Long enough for any real Orbit path, short enough that a URL cannot hide in one. */
export const MAX_PATH = 200;

const screenshotSchema = z.object({
  /**
   * A `data:image/...;base64,...` string. The declared mime is parsed and then DISCARDED —
   * see `decodeScreenshot`. The length bound here is a cheap early-out on the encoded
   * string; the real check is on the decoded bytes.
   */
  dataUrl: z.string().min(1).max(Math.ceil(MAX_SCREENSHOT_BYTES * 1.4)),
  note: z.string().trim().max(MAX_SHOT_NOTE).optional(),
  width: z.number().int().positive().max(20_000).optional(),
  height: z.number().int().positive().max(20_000).optional(),
});

export const feedbackSubmissionSchema = z.object({
  text: z.string().trim().min(1, "Add a note before sending.").max(MAX_FEEDBACK_TEXT),
  area: z.enum(FEEDBACK_AREAS).optional(),
  category: z.enum(FEEDBACK_CATEGORIES).optional(),
  /** Where they were. Pathname only — see `sanitizePath`. */
  path: z.string().max(MAX_PATH).optional(),
  viewport: z
    .object({
      w: z.number().int().min(0).max(20_000),
      h: z.number().int().min(0).max(20_000),
    })
    .optional(),
  devicePixelRatio: z.number().min(0).max(10).optional(),
  theme: z.enum(["light", "dark"]).optional(),
  timeZone: z.string().max(80).optional(),
  clientBuildTime: z.string().max(40).optional(),
  contactOk: z.boolean().optional(),
  screenshots: z.array(screenshotSchema).max(MAX_SCREENSHOTS).default([]),
});

export type FeedbackSubmissionInput = z.input<typeof feedbackSubmissionSchema>;
export type FeedbackSubmissionParsed = z.output<typeof feedbackSubmissionSchema>;

/**
 * Image types we accept, identified by their leading bytes.
 *
 * WebP needs BOTH checks: `RIFF` at offset 0 is shared with WAV and AVI, and only the
 * `WEBP` tag at offset 8 distinguishes them.
 */
const SIGNATURES: Array<{ type: string; test: (b: Buffer) => boolean }> = [
  {
    type: "image/webp",
    test: (b) =>
      b.length > 12 &&
      b.toString("ascii", 0, 4) === "RIFF" &&
      b.toString("ascii", 8, 12) === "WEBP",
  },
  {
    type: "image/png",
    test: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
  },
  {
    type: "image/jpeg",
    test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
];

export type DecodedScreenshot = { buf: Buffer; contentType: string };

/**
 * Decode one screenshot and identify it BY ITS BYTES.
 *
 * The `data:` header is split off and thrown away. This is the single most important check
 * in the feature: `/api/feedback/screenshots/[shotId]` is same-origin and serves what this
 * function stored with the content type this function chose, so believing a client that
 * claims `image/webp` over an HTML payload is stored XSS with extra steps. The type written
 * to the row is the one the bytes prove, or the row is never written.
 *
 * Returns null on anything suspect; the caller turns that into a message naming which shot.
 */
export function decodeScreenshot(dataUrl: string): DecodedScreenshot | null {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return null;

  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;

  const header = dataUrl.slice(0, comma);
  if (!header.includes(";base64")) return null;

  const payload = dataUrl.slice(comma + 1);
  if (!payload) return null;

  let buf: Buffer;
  try {
    buf = Buffer.from(payload, "base64");
  } catch {
    return null;
  }

  // Buffer.from ignores non-base64 characters rather than throwing, so an empty or absurd
  // result is the only signal that the payload was junk.
  if (buf.byteLength === 0 || buf.byteLength > MAX_SCREENSHOT_BYTES) return null;

  const match = SIGNATURES.find((sig) => sig.test(buf));
  if (!match) return null;

  return { buf, contentType: match.type };
}

/**
 * Reduce a client-reported location to a pathname, or nothing.
 *
 * Stored and later rendered in the admin console, so a value that could become a link to
 * somewhere else — `javascript:alert(1)`, `https://evil.test/x`, protocol-relative
 * `//evil.test` — has to become null here rather than being cleaned up at render time by
 * everyone who touches it.
 */
export function sanitizePath(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;

  const hashless = raw.split("#")[0].trim();
  if (!hashless.startsWith("/")) return null;
  if (hashless.startsWith("//")) return null;
  if (hashless.length > MAX_PATH) return null;

  return hashless;
}

/** File extension for the types `decodeScreenshot` admits. */
function extensionFor(contentType: string): string {
  if (contentType === "image/png") return "png";
  if (contentType === "image/jpeg") return "jpg";
  return "webp";
}

type PersistedScreenshot =
  | { storage: "blob"; blobUrl: string; inlineData: null }
  | { storage: "inline"; blobUrl: null; inlineData: string };

/**
 * Put one screenshot where it can be served from.
 *
 * Mirrors `persistAvatar` in `src/lib/contact-avatar.ts`, with one deliberate divergence:
 * `addRandomSuffix: true`. Avatars are written to a deterministic `avatars/<contactId>.jpg`
 * whose public URL is therefore guessable from an id that appears in the DOM. That is a
 * tolerable trade for a third-party profile photo and an intolerable one for a picture of
 * somebody's actual CRM.
 *
 * Throws when a CONFIGURED store rejects the upload — a silent fallback to inline would
 * quietly put a 500 KB row in Postgres on every failure and nobody would find out.
 */
async function persistScreenshot(
  feedbackId: string,
  index: number,
  shot: DecodedScreenshot
): Promise<PersistedScreenshot> {
  if (!hasBlobStorage()) {
    return { storage: "inline", blobUrl: null, inlineData: shot.buf.toString("base64") };
  }

  const blob = await put(
    `feedback/${feedbackId}/${index}.${extensionFor(shot.contentType)}`,
    shot.buf,
    { access: "public", contentType: shot.contentType, addRandomSuffix: true }
  );
  return { storage: "blob", blobUrl: blob.url, inlineData: null };
}

export type FeedbackScreenshotInput = DecodedScreenshot & {
  note: string | null;
  width: number | null;
  height: number | null;
};

/**
 * Write one feedback entry and its screenshots.
 *
 * A new function rather than an extension of `recordFeedback`, which swallows every error
 * and returns void. Neither property survives here: a person is watching a submit button,
 * and the child rows need the parent's id. `recordFeedback` is left exactly as it is for
 * the PMF and churn prompts.
 *
 * The parent is inserted first, so a blob failure aborts with one childless parent row
 * rather than a half-populated gallery that reads as "one of my screenshots vanished".
 */
export async function createFeedbackSubmission(input: {
  userId: string;
  text: string;
  area: FeedbackArea | null;
  category: FeedbackCategory | null;
  context: Record<string, unknown>;
  screenshots: FeedbackScreenshotInput[];
}): Promise<{ id: string; screenshotCount: number }> {
  const db = await getDb();

  const [entry] = await db
    .insert(feedback)
    .values({
      userId: input.userId,
      kind: "freeform",
      text: input.text,
      area: input.area,
      category: input.category,
      context: input.context,
    })
    // Bare, not `.returning({ id })` — an explicit field selector defeats Drizzle's
    // overload resolution in this TS version, the same way it does in `interest-list.ts`
    // and `import-engine.ts`.
    .returning();

  if (input.screenshots.length === 0) return { id: entry.id, screenshotCount: 0 };

  const rows: (typeof feedbackScreenshots.$inferInsert)[] = [];
  for (const [index, shot] of input.screenshots.entries()) {
    const stored = await persistScreenshot(entry.id, index, shot);
    rows.push({
      feedbackId: entry.id,
      userId: input.userId,
      position: index,
      note: shot.note,
      storage: stored.storage,
      blobUrl: stored.blobUrl,
      inlineData: stored.inlineData,
      contentType: shot.contentType,
      byteSize: shot.buf.byteLength,
      width: shot.width,
      height: shot.height,
    });
  }

  await db.insert(feedbackScreenshots).values(rows);
  return { id: entry.id, screenshotCount: rows.length };
}
