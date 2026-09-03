/**
 * Read a profile page's text into contact fields.
 *
 * The adapters get the two fields that are free and certain — the person's name
 * and the profile URL — from the page's own structure. Everything else on a
 * logged-in LinkedIn profile lives in prose that no selector survives for long:
 * the title and company are in the top card, the education in a section
 * further down, and the class names change without notice. Measured on a real
 * profile the adapter recovered exactly one field.
 *
 * So the rest is read by a model. One code path, immune to DOM churn, and the
 * text demonstrably contains the answer — the starter generator was already
 * describing someone's degree from the same blob the adapter had given up on.
 *
 * Deliberately *not* `parseMultiPersonNotesWithAI`: that is built for a dump of
 * notes about several people, with a two-pass path and shared-context handling.
 * On a single profile it invites the model to invent extra people out of page
 * furniture, and the second pass is latency this flow cannot spend — capture is
 * meant to feel like a reflex.
 */

import { z } from "zod";
import { completeJson, parseAiJson, userHasAiKey } from "@/lib/ai";
import { untrustedPageBlock } from "@/lib/conversation-starters";
import type { PageContext, ParsedProfileFields } from "./contract";

const nullStr = z
  .string()
  .max(300)
  .nullish()
  .transform((v) => v?.trim() || null);

const strList = z
  .array(z.string().max(300))
  .max(12)
  .nullish()
  .transform((v) => (v ?? []).map((s) => s.trim()).filter(Boolean));

const profileSchema = z.object({
  full_name: nullStr,
  title: nullStr,
  company: nullStr,
  location: nullStr,
  school: nullStr,
  email: nullStr,
  key_facts: strList,
  shared_interests: strList,
  /** Keys above the model was unsure about — drives the provenance marker. */
  low_confidence_fields: strList,
});

const SYSTEM = [
  "You extract one person's details from the text of a profile page they own.",
  'Return JSON only: {"full_name","title","company","location","school","email","key_facts":[],"shared_interests":[],"low_confidence_fields":[]}.',
  "The page is about exactly ONE person. Other names in the text are page furniture — suggested profiles, commenters, colleagues — and must be ignored.",
  "title is their current role only. company is their current employer only. Never combine them into one string.",
  "key_facts: up to 4 short, concrete, durable facts about this person's work or background. No adjectives, no praise, nothing that will be stale in a month.",
  "shared_interests: up to 3 topics they visibly care about.",
  "Use null for anything the text does not clearly state. Never guess, never infer from a name, never fill a field to be helpful.",
  "List in low_confidence_fields any field you are less than sure about.",
].join("\n");

/**
 * Fields the model read from the page. Never throws for an AI reason: no key,
 * a bad response, or a timeout all return `degraded` with nothing filled, and
 * the record keeps whatever the adapter found.
 */
export async function parseProfileFields(
  userId: string,
  page: PageContext
): Promise<ParsedProfileFields> {
  const empty: ParsedProfileFields = {
    fullName: null,
    title: null,
    company: null,
    location: null,
    school: null,
    email: null,
    keyFacts: [],
    sharedInterests: [],
    lowConfidence: [],
    degraded: true,
  };

  const blob = untrustedPageBlock(page);
  if (!blob) return { ...empty, degradedReason: "no_text" };
  if (!(await userHasAiKey(userId))) {
    return { ...empty, degradedReason: "no_api_key" };
  }

  let content: string;
  try {
    content = await completeJson(userId, {
      system: SYSTEM,
      user: [
        // What the adapter already knows, so the model corroborates rather than
        // contradicts — and so it knows which person the page is about.
        page.identity.name?.value
          ? `The page belongs to: ${page.identity.name.value}`
          : null,
        blob,
      ]
        .filter(Boolean)
        .join("\n\n"),
      temperature: 0.1,
      maxOutputTokens: 4096,
    });
  } catch (error) {
    console.warn("[parse-profile] model call failed", error);
    return { ...empty, degradedReason: "ai_error" };
  }

  const parsed = profileSchema.safeParse(parseAiJson(content));
  if (!parsed.success) {
    console.warn("[parse-profile] unparseable response", content.slice(0, 300));
    return { ...empty, degradedReason: "ai_error" };
  }

  const data = parsed.data;
  return {
    fullName: data.full_name,
    title: data.title,
    company: data.company,
    location: data.location,
    school: data.school,
    email: data.email,
    keyFacts: data.key_facts,
    sharedInterests: data.shared_interests,
    lowConfidence: data.low_confidence_fields,
    degraded: false,
  };
}
