/**
 * The database half of the onboarding "About you" step: the self-lookup and the confirm save.
 * No auth: callers pass the user id, so `scripts/smoke-about-you-save.ts` drives it on PGlite.
 * `src/actions/about-you.ts` is the authenticated door and validates input with
 * `parseAboutConfirm` first.
 *
 * The rule throughout: onboarding fills only what is empty, and replaces a value only when the
 * person edited it on the confirm screen. The writes run in sequence and each is idempotent, so
 * a retry after a partial failure is safe.
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings, type CareerProfile } from "@/db/schema";
import {
  AIM_KINDS,
  FIELDS,
  FIELD_ROLE_TITLE,
  TIMELINES,
  isJobHuntingAim,
  parseOwnLinkedInUrl,
  type AboutAnswers,
} from "@/lib/about-you";
import { mergedSchools } from "@/lib/career-profile";
import { loadYouCurrent } from "@/lib/career-profile-server";
import { addTargetCompany, setSchools } from "@/lib/events/target-companies";
import { MAX_ROLE_KEYWORDS, MAX_SCHOOLS } from "@/lib/linkedin-you";
import { normalizeSenderBio } from "@/lib/sender-profile";
import { addGoalForUser, listActiveGoalTextsForUser, MAX_GOAL_CHARS } from "@/lib/user-goals";
import { researchPerson, type PersonResearcher } from "@/lib/web-research";

export type AboutPrefill = {
  headline: string | null;
  role: { title: string; company: string } | null;
  location: string | null;
  summary: string | null;
  schools: string[];
  /** The most recent school's field of study, split on commas; at most `MAX_MAJORS`. */
  majors: string[];
};

export type AboutLookup = { status: "confident"; prefill: AboutPrefill } | { status: "unsure" | "none" | "unavailable" };

export type AboutConfirm = AboutAnswers & {
  goalSentence: string | null;
  selfIntro: string | null;
  edited: { headline: boolean; majors: boolean; selfIntro: boolean };
  prefill: AboutPrefill | null;
};

const MAX_COMPANIES = 5;
const NAME_MAX = 100;
const LINE_MAX = 200;
const SUMMARY_MAX = 600;
const SCHOOL_MAX = 120;
const MAX_MAJORS = 3;

/** One line of text, whitespace collapsed and capped; null when empty or not a string. */
function line(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function lines(value: unknown, max: number, count: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => line(v, max) ?? []).slice(0, count);
}

function oneOf<T extends string>(set: readonly T[], value: unknown): T | null | undefined {
  if (value === null || value === undefined) return null;
  return set.includes(value as T) ? (value as T) : undefined;
}

function parsePrefill(raw: unknown): AboutPrefill | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const role = typeof p.role === "object" && p.role !== null ? (p.role as Record<string, unknown>) : null;
  const title = line(role?.title, NAME_MAX);
  const company = line(role?.company, NAME_MAX);
  return {
    headline: line(p.headline, LINE_MAX),
    role: title && company ? { title, company } : null,
    location: line(p.location, NAME_MAX),
    summary: line(p.summary, SUMMARY_MAX),
    schools: lines(p.schools, SCHOOL_MAX, MAX_SCHOOLS),
    majors: lines(p.majors, SCHOOL_MAX, MAX_MAJORS),
  };
}

/** The confirm payload as the server will trust it, or null when an answer is not one of ours. */
export function parseAboutConfirm(raw: unknown): AboutConfirm | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const aim = oneOf(AIM_KINDS, r.aim);
  const timeline = oneOf(TIMELINES, r.timeline);
  const field = oneOf(FIELDS, r.field);
  if (aim === undefined || timeline === undefined || field === undefined) return null;
  const edited = typeof r.edited === "object" && r.edited !== null ? (r.edited as Record<string, unknown>) : {};
  return {
    aim,
    timeline,
    field,
    companies: lines(r.companies, NAME_MAX, MAX_COMPANIES),
    schools: lines(r.schools, SCHOOL_MAX, MAX_SCHOOLS),
    majors: lines(r.majors, SCHOOL_MAX, MAX_MAJORS),
    headline: line(r.headline, LINE_MAX),
    goalSentence: line(r.goalSentence, MAX_GOAL_CHARS),
    selfIntro: normalizeSenderBio(r.selfIntro),
    edited: {
      headline: edited.headline === true,
      majors: edited.majors === true,
      selfIntro: edited.selfIntro === true,
    },
    prefill: parsePrefill(r.prefill),
  };
}

/**
 * Screen 1: save the person's own LinkedIn URL, then brief them with `researchPerson` (same
 * cache, rate limit and AI gate as /find). Only a `confident` answer becomes a prefill; nothing
 * from the lookup is stored here. No name on file, no AI, a refusal or a throw: `unavailable`.
 */
export async function lookUpSelfForUser(
  userId: string,
  linkedinUrl: string,
  opts: { researcher?: PersonResearcher } = {},
): Promise<AboutLookup> {
  const parsed = parseOwnLinkedInUrl(linkedinUrl);
  if (!parsed.ok) return { status: "unavailable" };

  const db = await getDb();
  // Merge one key: the other links are what the person typed in Settings.
  await db.execute(sql`
    INSERT INTO user_settings (user_id, social_links)
    VALUES (${userId}, ${JSON.stringify({ linkedin: parsed.url })}::jsonb)
    ON CONFLICT (user_id) DO UPDATE SET
      social_links = COALESCE(user_settings.social_links, '{}'::jsonb) || excluded.social_links,
      updated_at = now()
  `);

  const [row] = await db
    .select({ first: userSettings.firstName, last: userSettings.lastName })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);
  const fullName = [row?.first, row?.last].map((s) => s?.trim()).filter(Boolean).join(" ");
  if (!fullName) return { status: "unavailable" };

  try {
    const result = await researchPerson(userId, { fullName, linkedinUrl: parsed.url }, { researcher: opts.researcher });
    if (!result.ok) return { status: "unavailable" };
    const d = result.dossier;
    if (d.match !== "confident") return { status: d.match };
    const title = line(d.current?.title, NAME_MAX);
    const company = line(d.current?.organization, NAME_MAX);
    const education = d.experiences.filter((e) => e.kind === "education");
    // Experiences come most recent first, so the first school is the current or latest one.
    const field = education[0]?.fieldOfStudy;
    return {
      status: "confident",
      prefill: {
        headline: line(d.headline, LINE_MAX),
        role: title && company ? { title, company } : null,
        location: line(d.location, NAME_MAX),
        summary: line(d.summary, SUMMARY_MAX),
        schools: lines(
          education.map((e) => e.organization),
          SCHOOL_MAX,
          MAX_SCHOOLS,
        ),
        majors: lines(field ? field.split(/[,;]/) : [], SCHOOL_MAX, MAX_MAJORS),
      },
    };
  } catch {
    return { status: "unavailable" };
  }
}

/** Screen 3's confirm. Input is assumed validated (`parseAboutConfirm`). */
export async function saveAboutYouForUser(userId: string, input: AboutConfirm): Promise<void> {
  const current = await loadYouCurrent(userId);
  const career = current.career ?? {};
  const prefill = input.prefill;

  // 1–3: profile/role, aim, roleKeywords, read once and written once so they agree.
  const patch: CareerProfile = {};
  const profile = { ...career.profile };
  // An edited row is the person's word, even when they cleared it: never fall back to the lookup.
  const headline = input.edited.headline ? input.headline : (input.headline ?? prefill?.headline ?? null);
  if (headline && (input.edited.headline || !profile.headline)) profile.headline = headline;
  if (prefill?.location && !profile.location) profile.location = prefill.location;
  if (prefill?.summary && !profile.summary) profile.summary = prefill.summary;
  if (JSON.stringify(profile) !== JSON.stringify(career.profile ?? {})) patch.profile = profile;
  if (prefill?.role && !career.role) patch.role = prefill.role;
  // Majors follow the headline's rule: an edit is the person's word, else fill only an empty list.
  const majors = input.edited.majors ? input.majors : input.majors.length ? input.majors : (prefill?.majors ?? []);
  if (majors.length && (input.edited.majors || !career.majors?.length)) patch.majors = majors;
  if (input.aim) {
    patch.aim = { kind: input.aim, timeline: input.timeline, field: input.field, setAt: new Date().toISOString() };
    if (input.field && isJobHuntingAim(input.aim)) {
      const title = FIELD_ROLE_TITLE[input.field];
      const keywords = career.roleKeywords ?? [];
      if (keywords.length < MAX_ROLE_KEYWORDS && !keywords.some((k) => k.toLowerCase() === title.toLowerCase())) {
        patch.roleKeywords = [...keywords, title];
      }
    }
  }
  const db = await getDb();
  if (Object.keys(patch).length) {
    await db.execute(sql`
      INSERT INTO user_settings (user_id, career_profile)
      VALUES (${userId}, ${JSON.stringify(patch)}::jsonb)
      ON CONFLICT (user_id) DO UPDATE SET
        career_profile = COALESCE(user_settings.career_profile, '{}'::jsonb) || excluded.career_profile,
        updated_at = now()
    `);
  }

  // 4: one goal, skipped when the same sentence is already an active goal.
  if (input.goalSentence) {
    const active = await listActiveGoalTextsForUser(userId);
    if (!active.some((t) => t.trim() === input.goalSentence)) await addGoalForUser(userId, input.goalSentence);
  }

  // 5: companies already on the list keep their priority and note.
  for (const name of input.companies) await addTargetCompany(userId, name, 1, null, { ifAbsent: true });

  // 6: schools are merged, never replaced.
  if (input.schools.length) await setSchools(userId, mergedSchools(current.schools, input.schools));

  // 7: the bio is what the person typed; only an empty one or an edit here replaces it.
  if (input.selfIntro && (!current.senderBio?.trim() || input.edited.selfIntro)) {
    await db
      .insert(userSettings)
      .values({ userId, senderBio: input.selfIntro })
      .onConflictDoUpdate({ target: userSettings.userId, set: { senderBio: input.selfIntro, updatedAt: new Date() } });
  }
}
