/**
 * What someone does, read from their job title — the rule the constellation groups by.
 *
 * Deterministic regexes, no model call: this runs for every contact on every layout. Order
 * matters and is the whole design:
 *   - Recruiting is checked FIRST. "Technical Recruiting Lead" is a recruiter; reading it as an
 *     engineer or a lead files the most useful person at a careers fair under the wrong group.
 *   - Specific functions before general ones: "Sales Engineer" is sales, "Machine Learning
 *     Engineer" is data, "Product Designer" is design, "Product Engineer" is engineering.
 *   - Leadership is a flag beside the function, not a function: a VP Engineering is an engineer
 *     who leads. Only titles that match no function at all ("CEO", "Partner") become founders.
 */

export type RoleFunction =
  | "founders"
  | "engineering"
  | "product"
  | "design"
  | "data"
  | "sales"
  | "marketing"
  | "people"
  | "operations"
  | "other";

export type RoleClusterKey = Exclude<RoleFunction, "other">;

export type TitleRole = { fn: RoleFunction; isLeader: boolean };

export const ROLE_CLUSTER_NAMES: Record<RoleClusterKey, string> = {
  founders: "Founders & Execs",
  engineering: "Engineers",
  product: "Product",
  design: "Designers",
  data: "Data & Research",
  sales: "Sales & BD",
  marketing: "Marketing",
  people: "People & Recruiting",
  operations: "Operations",
};

// Shared with `seniorityOf` in src/lib/events/relevance.ts — moved here, not changed.
export const FOUNDER_EXEC =
  /\b(founder|co-?founder|ceo|cto|coo|cfo|cpo|cmo|chief|president|partner|managing director|owner)\b/i;
export const LEADER = /\b(head of|vp|vice president|director|principal|lead|manager|staff)\b/i;
export const RECRUITER =
  /\b(recruit(?:er|ing)|talent|sourcer|people ops|hr|human resources|campus|university relations|hiring)\b/i;

/**
 * Senior enough for a company's leadership core. Deliberately narrower than LEADER: a manager,
 * a lead or a staff engineer is not who the core of a 300-person company should be.
 */
const EXECUTIVE = /\b(head of|s?vp|evp|vice president|director)\b/i;
/** Junior "Director"/"VP" titles that carry the word without the seniority. */
const JUNIOR_EXEC =
  /\b(associate director|assistant director|assistant vice president|avp|account director|art director|creative director)\b/i;
/**
 * The one junior title that trips FOUNDER_EXEC on its own: "Assistant Vice President" matches
 * "president". Every other junior title (associate/assistant/art/creative director) never
 * matches FOUNDER_EXEC, so it must not cancel an owner's or partner's leadership.
 */
const JUNIOR_PRESIDENT = /\bassistant vice president\b/i;
/** For recruiters, "partner" is a job title ("Talent Partner"), not an ownership stake. */
const RECRUITER_EXEC = /\b(chief|co-?founder|founder)\b/i;
/**
 * Titles that match FOUNDER_EXEC only through a weak word — "Product Owner" is not ownership,
 * "Partner" is not a stake. It never cancels a strong word (STRONG_EXEC): a "Founder & Product
 * Owner" and a "Student Founder" still founded something.
 */
const NOT_LEADER = /\b(product owner|partner (?:engineer|manager|marketing|success|solutions?)|(?:channel|client|business|strategic) partner|student)\b/i;

const STRONG_EXEC = /\b(founder|co-?founder|ceo|cto|coo|cfo|cpo|cmo|chief)\b/i;

function isExecutive(value: string) {
  return EXECUTIVE.test(value) && !JUNIOR_EXEC.test(value);
}

const FUNCTION_RULES: Array<[RoleClusterKey, RegExp]> = [
  ["design", /\b(design(?:er)?|ux|creative director|art director|illustrator)\b/i],
  ["data", /\b(data|scientist|research(?:er)?|machine learning|ml|statistician)\b/i],
  [
    "sales",
    /\b(sales|account executive|account manager|business development|bdr|sdr|partnerships|customer success|solutions engineer)\b/i,
  ],
  ["engineering", /\b(engineer(?:ing)?|developer|swe|sde|programmer|architect|devops|sre|software|cto)\b/i],
  ["marketing", /\b(marketing|marketer|growth|brand|content|communications|comms|community|cmo)\b/i],
  ["product", /\b(product|pm|program manager|cpo)\b/i],
  [
    "operations",
    /\b(operations|ops|finance|financial|accounting|accountant|legal|counsel|lawyer|attorney|coo|cfo|chief of staff|administrator)\b/i,
  ],
];

export function classifyTitle(title: string | null | undefined): TitleRole {
  const value = title?.trim();
  if (!value) return { fn: "other", isLeader: false };
  if (RECRUITER.test(value)) {
    return { fn: "people", isLeader: isExecutive(value) || RECRUITER_EXEC.test(value) };
  }
  const isLeader =
    STRONG_EXEC.test(value) ||
    (FOUNDER_EXEC.test(value) && !NOT_LEADER.test(value) && !JUNIOR_PRESIDENT.test(value)) ||
    isExecutive(value);
  for (const [fn, pattern] of FUNCTION_RULES) {
    if (pattern.test(value)) return { fn, isLeader };
  }
  return { fn: isLeader ? "founders" : "other", isLeader };
}

/** The cross-company role cluster a person would join, or null when their function is unknown. */
export function roleClusterKey(role: TitleRole): RoleClusterKey | null {
  if (role.isLeader) return "founders";
  return role.fn === "other" ? null : role.fn;
}
