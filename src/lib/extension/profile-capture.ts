/**
 * Server side of an extension profile capture.
 *
 * Three jobs, in this order: prove the page is about the contact it claims to be about,
 * recover structure the selectors missed, then hand off to `saveContactProfile`.
 *
 * The first is the important one. Writing one person's career onto another is the worst
 * thing this feature can do and the hardest to notice afterwards, so a slug disagreement
 * stops the write and asks, rather than trusting the panel's resolution. The identity check
 * is deliberately JS-to-JS (see `linkedinSlug` below) and does not read the `linkedin_slug`
 * generated column — it does not need to, and does not depend on that column's definition.
 */

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { completeJson, parseAiJson, userHasAiKey } from "@/lib/ai";
import { untrustedPageBlock } from "@/lib/conversation-starters";
import { ContactNotFoundError } from "@/lib/contact-writes";
import { saveContactProfile, type IncomingExperience } from "@/lib/contact-profile";
import { linkedinSlug } from "@/lib/duplicates";
import type { PageContext, PageProfile, ProfileCaptureInput, ProfileCaptureResponse } from "./contract";
import { pageProfileSchema } from "./contract.schema";
import { ExtensionRouteError } from "./http";

export type { ProfileCaptureInput };

/**
 * A page's own `url` (or `sourceUrl`) may not even be a LinkedIn URL — a spoofed or buggy
 * capture, or an SSRF attempt via a URL later fetched by the avatar pipeline
 * (`fetchLinkedInPhotoUrl`) or rendered as an `href`. Only an https `linkedin.com` URL is
 * ever persisted as `sourceUrl` or written onto `contacts.linkedinUrl`; the identity-slug
 * comparison below is a separate, looser concern and does not use this.
 */
function isLinkedInProfileUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && /(^|\.)linkedin\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

/** A date the extension sent that fails to parse must not turn a capture into a 500. */
function parseCapturedAt(value: string): Date {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

const fallbackSchema = z.object({ profile: pageProfileSchema });

const FALLBACK_SYSTEM = [
  "You read a LinkedIn profile page's text and return the person's profile as JSON.",
  'Return JSON only: { "profile": { "headline", "about", "skills":[{"name"}],',
  '"certifications":[{"name","issuer","year"}], "volunteering":[{"organization","role","years"}],',
  '"publications":[{"title","publisher","year"}], "experiences":[{"kind","organization","title",',
  '"fieldOfStudy","location","description","startYear","startMonth","endYear","endMonth","isCurrent"}],',
  '"parseIncomplete" } }.',
  "kind is 'role' for jobs and 'education' for schools.",
  "Use null for anything absent; never invent an employer, a title, or a date.",
].join("\n");

/**
 * Ask the model only when the selectors came back empty. Never throws: no key, empty page
 * text, a timeout, or malformed output all mean the same thing here — keep whatever the
 * selectors got, and let the caller degrade gracefully.
 */
async function fallbackParse(
  userId: string,
  page: PageContext
): Promise<PageProfile | null> {
  const blob = untrustedPageBlock(page);
  if (!blob) return null;
  try {
    // Inside the try, not before it: a settings-load failure inside userHasAiKey must not
    // escape this function either.
    if (!(await userHasAiKey(userId))) return null;
    const raw = await completeJson(userId, {
      system: FALLBACK_SYSTEM,
      user: blob,
      temperature: 0.1,
      maxOutputTokens: 4096,
      operation: "capture.profile.fallback",
    });
    const parsed = fallbackSchema.safeParse(parseAiJson(raw));
    if (!parsed.success) {
      console.warn("[profile-capture] unparseable fallback response", raw.slice(0, 300));
      return null;
    }
    return parsed.data.profile;
  } catch (error) {
    console.warn("[profile-capture] fallback parse failed", error);
    return null;
  }
}

function toIncoming(profile: PageProfile): IncomingExperience[] {
  return profile.experiences.map((e) => ({
    kind: e.kind,
    organization: e.organization,
    title: e.title,
    fieldOfStudy: e.fieldOfStudy,
    location: e.location,
    description: e.description,
    startYear: e.startYear,
    startMonth: e.startMonth,
    endYear: e.endYear,
    endMonth: e.endMonth,
    isCurrent: e.isCurrent,
  }));
}

export async function captureContactProfile(
  userId: string,
  input: ProfileCaptureInput
): Promise<ProfileCaptureResponse> {
  // A capture is only ever meaningful for a LinkedIn person page. Refusing anything else
  // here — before touching the contact at all — stops a `site:"gmail"` or `kind:"thread"`
  // page carrying a `profile` block from ever reaching the write path below.
  if (input.page.site !== "linkedin" || input.page.kind !== "person") {
    throw new ExtensionRouteError(
      "invalid_request",
      "Profile capture only accepts a LinkedIn profile page."
    );
  }

  const db = await getDb();
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.userId, userId), eq(contacts.id, input.contactId)),
    columns: { id: true, fullName: true, linkedinUrl: true },
  });
  // A contact belonging to another user must read identically to a contact that does not
  // exist at all — never leak which one it was.
  if (!contact) throw new ContactNotFoundError();

  // `linkedinSlug` (from `@/lib/duplicates`, the same rule `resolve.ts` uses to find the
  // contact in the first place) never returns null: "" means "no identifiable LinkedIn
  // identity at all," which is itself a value that must be treated as disagreeing with a
  // contact that DOES have one — not as "no opinion, proceed." That is the fail-closed
  // half of this guard: an unset flag defaults to refuse, not to accept.
  const pageSlug = linkedinSlug(input.page.url) || linkedinSlug(input.page.sourceUrl);
  const contactSlug = linkedinSlug(contact.linkedinUrl);

  // A contact with literally no URL on file is a gap, not a disagreement — accepting the
  // capture fills it. Once the contact has ANY slug (including a non-`/in/` URL, which
  // `linkedinSlug` normalizes rather than drops), anything other than an exact match —
  // including the page having no identifiable slug at all — is a conflict.
  if (contactSlug && pageSlug !== contactSlug && !input.confirmMismatch) {
    return {
      saved: false,
      conflict: { pageSlug, contactSlug, contactName: contact.fullName },
      usedFallback: false,
      degraded: false,
      experienceCount: 0,
    };
  }

  let profile = input.page.profile ?? null;
  let usedFallback = false;
  if (!profile || profile.parseIncomplete || profile.experiences.length === 0) {
    const recovered = await fallbackParse(userId, input.page);
    if (recovered) {
      usedFallback = true;
      profile = recovered;
    }
  }

  if (!profile) {
    return { saved: false, conflict: null, usedFallback, degraded: true, experienceCount: 0 };
  }

  const warnings = [...input.page.warnings];
  if (profile.parseIncomplete && !usedFallback) warnings.push("parse-incomplete");

  // Only ever persist (or later dereference, or write onto the contact) a URL that is
  // actually an https linkedin.com URL — `site`/`kind` describe what the client CLAIMS the
  // page is, this checks the URL string itself.
  const validPageUrl = isLinkedInProfileUrl(input.page.url) ? input.page.url : null;

  await saveContactProfile(userId, input.contactId, {
    source: "extension",
    sourceUrl: validPageUrl,
    adapterVersion: input.page.adapterVersion,
    capturedAt: parseCapturedAt(input.page.capturedAt),
    warnings,
    headline: profile.headline,
    about: profile.about,
    skills: profile.skills,
    certifications: profile.certifications,
    volunteering: profile.volunteering,
    publications: profile.publications,
    experiences: toIncoming(profile),
  });

  // Accepting a capture for a contact we had NO URL for at all is how that URL gets on
  // file. Keyed on the actual stored column, not on `contactSlug` — a contact whose stored
  // URL simply doesn't parse to a slug (a Sales Navigator link, an uppercase `/IN/` path)
  // already has a URL and must not have it silently replaced by this capture's page.
  if (!contact.linkedinUrl?.trim() && validPageUrl) {
    await db
      .update(contacts)
      .set({ linkedinUrl: validPageUrl })
      .where(and(eq(contacts.userId, userId), eq(contacts.id, input.contactId)));
  }

  return {
    saved: true,
    conflict: null,
    usedFallback,
    degraded: false,
    experienceCount: profile.experiences.length,
  };
}
