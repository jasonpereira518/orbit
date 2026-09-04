/**
 * Server side of an extension profile capture.
 *
 * Three jobs, in this order: prove the page is about the contact it claims to be about,
 * recover structure the selectors missed, then hand off to `saveContactProfile`.
 *
 * The first is the important one. Writing one person's career onto another is the worst
 * thing this feature can do and the hardest to notice afterwards, so a slug disagreement
 * stops the write and asks, rather than trusting the panel's resolution.
 */

import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { completeJson, parseAiJson, userHasAiKey } from "@/lib/ai";
import { untrustedPageBlock } from "@/lib/conversation-starters";
import { saveContactProfile, type IncomingExperience } from "@/lib/contact-profile";
import type { PageContext, PageProfile, ProfileCaptureResponse } from "./contract";
import { pageProfileSchema } from "./contract.schema";

export type ProfileCaptureInput = {
  contactId: string;
  page: PageContext;
  confirmMismatch?: boolean;
};

/**
 * Reproduces the `linkedin_slug` generated column in `src/db/schema.ts`: everything after
 * the first `/in/` up to a `/`, `?` or `#`, lowercased. Must stay in step with it — the
 * comparison below is meaningless if the two disagree.
 *
 * Postgres's `split_part` matches the `/in/` delimiter case-sensitively, so the regex below
 * does too — only the captured slug itself is lowercased, matching the column's outer
 * `lower(...)`.
 */
function linkedinSlug(url: string | null | undefined): string | null {
  const value = url?.trim();
  if (!value) return null;
  const match = value.match(/\/in\/([^/?#]+)/);
  return match?.[1]?.toLowerCase() ?? null;
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

/** Ask the model only when the selectors came back empty. */
async function fallbackParse(
  userId: string,
  page: PageContext
): Promise<PageProfile | null> {
  if (!(await userHasAiKey(userId))) return null;
  try {
    const raw = await completeJson(userId, {
      system: FALLBACK_SYSTEM,
      user: untrustedPageBlock(page),
      temperature: 0.1,
      maxOutputTokens: 4096,
      operation: "capture.profile.fallback",
    });
    const parsed = fallbackSchema.safeParse(parseAiJson(raw));
    return parsed.success ? parsed.data.profile : null;
  } catch {
    // No key, a timeout, or malformed output all mean the same thing here: keep whatever
    // the selectors got. This path never throws to the route.
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
  const db = await getDb();
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.userId, userId), eq(contacts.id, input.contactId)),
    columns: { id: true, fullName: true, linkedinUrl: true },
  });
  if (!contact) {
    return { saved: false, conflict: null, usedFallback: false, degraded: false, experienceCount: 0 };
  }

  const pageSlug = linkedinSlug(input.page.url) ?? linkedinSlug(input.page.sourceUrl);
  const contactSlug = linkedinSlug(contact.linkedinUrl);

  // A contact with no URL on file is a gap, not a disagreement — accepting the capture
  // fills it. Only two *known and different* identities are a conflict.
  if (pageSlug && contactSlug && pageSlug !== contactSlug && !input.confirmMismatch) {
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

  await saveContactProfile(userId, input.contactId, {
    source: "extension",
    sourceUrl: input.page.url,
    adapterVersion: input.page.adapterVersion,
    capturedAt: new Date(input.page.capturedAt),
    warnings,
    headline: profile.headline,
    about: profile.about,
    skills: profile.skills,
    certifications: profile.certifications,
    volunteering: profile.volunteering,
    publications: profile.publications,
    experiences: toIncoming(profile),
  });

  // Accepting a capture for a contact we had no URL for is how that URL gets on file.
  if (!contactSlug && input.page.url) {
    await db
      .update(contacts)
      .set({ linkedinUrl: input.page.url })
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
