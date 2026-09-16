import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseJsonObject } from "@/lib/outreach/json";
import {
  CRITERION_KINDS,
  type JsonCompleter,
  type OutreachBrief,
  type OutreachCriteria,
  type OutreachCriterion,
} from "@/lib/outreach/types";

export const briefSchema = z.object({
  purpose: z.string().trim().min(10, "Say a little more about what this campaign is for").max(1000),
  desiredOutcome: z.string().trim().min(3, "Say what a good outcome looks like").max(500),
  notes: z.string().trim().max(2000).optional(),
});

export const EMPTY_CRITERIA: OutreachCriteria = { required: [], preferred: [], exclusions: [] };

const GROUPS = ["required", "preferred", "exclusions"] as const;
type Group = (typeof GROUPS)[number];
const GROUP_LIMIT: Record<Group, number> = { required: 6, preferred: 8, exclusions: 6 };

const criterionInput = z.object({
  id: z.string().trim().min(1).max(64).optional(),
  kind: z.enum(CRITERION_KINDS),
  label: z.string().trim().min(1).max(120),
  values: z.array(z.string()).max(24),
  priority: z.number().optional(),
});

/**
 * Accepts anything (model output, a client form) and returns well-formed criteria. Invalid
 * entries are DROPPED one at a time rather than failing the whole object: a model that
 * invents one bad kind should cost that criterion, not the audience.
 */
export function normalizeCriteria(input: unknown): OutreachCriteria {
  const record = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const out: OutreachCriteria = { required: [], preferred: [], exclusions: [] };
  for (const group of GROUPS) {
    const raw = Array.isArray(record[group]) ? (record[group] as unknown[]) : [];
    for (const item of raw) {
      const parsed = criterionInput.safeParse(item);
      if (!parsed.success) continue;
      const values = Array.from(
        new Set(parsed.data.values.map((v) => v.trim()).filter((v) => v.length > 0 && v.length <= 120))
      ).slice(0, 12);
      if (values.length === 0) values.push(parsed.data.label);
      let id = parsed.data.id ?? randomUUID();
      if (seen.has(id)) id = randomUUID();
      seen.add(id);
      out[group].push({ id, kind: parsed.data.kind, label: parsed.data.label, values, priority: 0 });
      if (out[group].length >= GROUP_LIMIT[group]) break;
    }
  }
  out.preferred = out.preferred.map((c, index) => ({ ...c, priority: index }));
  return out;
}

export function hasAnyCriteria(criteria: OutreachCriteria): boolean {
  return criteria.required.length + criteria.preferred.length + criteria.exclusions.length > 0;
}

export function listCriteria(
  criteria: OutreachCriteria
): Array<{ criterion: OutreachCriterion; group: Group }> {
  return GROUPS.flatMap((group) => criteria[group].map((criterion) => ({ criterion, group })));
}

const SYSTEM = `You turn a person's networking goal into audience criteria for finding people to contact, mostly on LinkedIn.
Return JSON exactly like {"required":[{"kind":"role","label":"...","values":["..."]}],"preferred":[...],"exclusions":[...]}.
- kind is one of: role, organization, geography, experience, other.
- required: must be true for someone to be worth contacting (at most 4).
- preferred: makes someone a better fit, most important first (at most 5).
- exclusions: rules someone out (at most 4).
- values are short search terms: job titles, company or industry names, places, skills.
- Never name specific people. Never invent facts about the user.`;

export async function criteriaFromBrief(
  userId: string,
  brief: OutreachBrief,
  complete: JsonCompleter
): Promise<{ criteria: OutreachCriteria; source: "ai" | "fallback" }> {
  const user = [
    `Purpose: ${brief.purpose}`,
    `Desired outcome: ${brief.desiredOutcome}`,
    brief.notes ? `Notes: ${brief.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const raw = await complete(userId, {
      system: SYSTEM,
      user,
      temperature: 0.2,
      maxOutputTokens: 1200,
      operation: "outreach.criteria",
    });
    const criteria = normalizeCriteria(parseJsonObject(raw));
    return hasAnyCriteria(criteria)
      ? { criteria, source: "ai" }
      : { criteria: EMPTY_CRITERIA, source: "fallback" };
  } catch {
    return { criteria: EMPTY_CRITERIA, source: "fallback" };
  }
}
