import { listCriteria } from "@/lib/outreach/criteria";
import { parseJsonObject } from "@/lib/outreach/json";
import type { JsonCompleter, OutreachBrief, OutreachCriteria } from "@/lib/outreach/types";

export type PlannedQuery = { q: string };

const SITE = "site:linkedin.com/in";

export function sanitizeQuery(q: string): string | null {
  let s = q.replace(/\s+/g, " ").trim();
  if (!s) return null;
  if (!/site:linkedin\.com\/in\b/i.test(s)) s = `${SITE} ${s}`;
  return s.slice(0, 300);
}

const quoted = (term: string) => `"${term.replace(/"/g, "").trim()}"`;

/** Deterministic fallback when planning with AI is unavailable (spec §7.3 step 1). */
export function templateQueries(criteria: OutreachCriteria, max: number): PlannedQuery[] {
  const values = (kind: string) =>
    [...criteria.required, ...criteria.preferred].filter((c) => c.kind === kind).flatMap((c) => c.values);
  const roles = values("role").slice(0, 4);
  const experience = values("experience").slice(0, 2);
  const orgs = values("organization").slice(0, 3);
  const places = values("geography").slice(0, 2);
  const exclusions = criteria.exclusions
    .flatMap((c) => c.values)
    .slice(0, 3)
    .map((v) => `-${quoted(v)}`)
    .join(" ");

  const leads = roles.length ? roles : experience.length ? experience : orgs;
  if (leads.length === 0 && places.length === 0) return [];
  const out: PlannedQuery[] = [];
  const seen = new Set<string>();
  for (const lead of leads.length ? leads : [""]) {
    for (const org of leads === orgs || orgs.length === 0 ? [""] : orgs) {
      for (const place of places.length ? places : [""]) {
        const q = [SITE, lead && quoted(lead), org && quoted(org), place && quoted(place), exclusions]
          .filter(Boolean)
          .join(" ");
        if (!seen.has(q)) {
          seen.add(q);
          out.push({ q });
        }
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

const SYSTEM = `Write web search queries that find the LinkedIn profiles of people matching an audience.
Rules: every query begins with site:linkedin.com/in. Use quoted phrases for job titles, companies and places. Add -"term" for exclusions. Vary titles and synonyms across queries instead of repeating one. Never include personal names.
Return JSON: {"queries":["..."]}`;

export async function planQueries(
  userId: string,
  brief: OutreachBrief,
  criteria: OutreachCriteria,
  max: number,
  complete: JsonCompleter
): Promise<{ queries: PlannedQuery[]; source: "ai" | "template" }> {
  const criteriaText = listCriteria(criteria)
    .map(({ criterion, group }) => `- [${group}] ${criterion.kind}: ${criterion.values.join(" / ")}`)
    .join("\n");
  try {
    const raw = await complete(userId, {
      system: SYSTEM,
      user: `Goal: ${brief.purpose}\nWanted outcome: ${brief.desiredOutcome}\nCriteria:\n${criteriaText}\nWrite at most ${max} queries.`,
      temperature: 0.3,
      maxOutputTokens: 800,
      operation: "outreach.plan",
    });
    const parsed = parseJsonObject(raw) as { queries?: unknown } | null;
    const list = Array.isArray(parsed?.queries) ? parsed.queries : [];
    const seen = new Set<string>();
    const queries: PlannedQuery[] = [];
    for (const item of list) {
      if (typeof item !== "string") continue;
      const q = sanitizeQuery(item);
      // A bare operator plus one character finds nothing useful.
      if (!q || q.length < SITE.length + 3 || seen.has(q.toLowerCase())) continue;
      seen.add(q.toLowerCase());
      queries.push({ q });
      if (queries.length >= max) break;
    }
    if (queries.length > 0) return { queries, source: "ai" };
  } catch {
    // fall through to the template
  }
  return { queries: templateQueries(criteria, max), source: "template" };
}
