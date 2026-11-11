/**
 * Evaluates whether an event is a professional networking / business event
 * versus an unprofessional party, casual social gathering, or personal event.
 *
 * Orbit is a professional relationship platform. Strictly professional events
 * (conferences, summits, demo days, pitch nights, workshops, tech meetups,
 * and professional mixers) are admitted. Casual parties (birthdays, baby showers,
 * bachelor/bachelorette parties, weddings, house parties, frat parties, pub crawls,
 * and game nights) are filtered out into the hidden pool at the bottom so the user
 * can manually add them back if desired.
 *
 * Pure: no database, no network dependencies.
 */

/** Unambiguously non-professional party / personal event keywords */
const UNPROFESSIONAL_PARTY_PATTERNS = [
  // Birthdays & Personal milestones
  /\b(?:birthday|bday|b-day|turning\s+\d+|sweet\s+16|quincea[ñn]era)\b/i,
  // Weddings & showers
  /\b(?:wedding|bridal\s+shower|bachelorette|bachelor\s+party|stag\s+(?:do|party)|hen\s+(?:do|party)|rehearsal\s+dinner)\b/i,
  // Baby & family
  /\b(?:baby\s+shower|gender\s+reveal|family\s+reunion|class\s+reunion|sleepover|slumber\s+party)\b/i,
  // Drinking, nightlife & games
  /\b(?:pub\s+crawl|bar\s+crawl|beer\s+crawl|bar\s+hopping|beer\s+pong|kegger|drinking\s+games?|rave\b|nightclub|clubbing|frat\s+party|fraternity\s+party|sorority\s+party)\b/i,
  // Casual house & social gatherings
  /\b(?:house\s+party|housewarming|apartment\s+warming|dorm\s+party|pajama\s+party|costume\s+party|ugly\s+sweater\s+party)\b/i,
  // Tailgates & non-professional cookouts
  /\b(?:tailgate\s+party|super\s+bowl\s+party|beer\s+bash|pool\s+party)\b/i,
];

/** Professional context keywords that override casual terms (e.g. "AI Launch Party", "Founder Mixer", "Tech Week Afterparty") */
const PROFESSIONAL_OVERRIDE_PATTERNS = [
  /\b(?:ai|artificial\s+intelligence|machine\s+learning|llm|deep\s+learning)\b/i,
  /\b(?:tech|technology|software|hardware|developer|engineering|devops|cloud|security)\b/i,
  /\b(?:founder|startup|co-founder|entrepreneur|pitch|demo\s+day|showcase)\b/i,
  /\b(?:venture|vc|angel\s+investor|fundraising|seed|series\s+[a-e]|capital)\b/i,
  /\b(?:conference|summit|symposium|convention|expo|congress|forum)\b/i,
  /\b(?:hackathon|buildathon|code\s+sprint|game\s+jam)\b/i,
  /\b(?:panel\s+discussion|fireside\s+chat|keynote|webinar|seminar|workshop|roundtable)\b/i,
  /\b(?:networking|career\s+fair|job\s+fair|hiring|recruiting|alumni\s+networking)\b/i,
  /\b(?:product\s+management|b2b|saas|fintech|biotech|climate\s+tech|web3|crypto)\b/i,
];

export type ProfessionalEvaluation = {
  isProfessional: boolean;
  reason?: string;
};

/**
 * Assesses whether an event candidate or record qualifies as a professional event.
 */
export function isUnprofessionalParty(event: {
  title?: string | null;
  description?: string | null;
  url?: string | null;
  source?: string | null;
  platform?: string | null;
}): boolean {
  const title = (event.title ?? "").trim();
  const desc = (event.description ?? "").trim();
  const text = `${title} ${desc}`.toLowerCase();

  if (!text.trim()) {
    return false; // Cannot determine, do not suppress
  }

  // 1. Check for strong override (explicit professional context)
  const hasProfessionalContext = PROFESSIONAL_OVERRIDE_PATTERNS.some((pattern) =>
    pattern.test(title) || pattern.test(desc)
  );

  // 2. Check for explicit unprofessional party indicators
  const hasUnprofessionalIndicators = UNPROFESSIONAL_PARTY_PATTERNS.some((pattern) =>
    pattern.test(title) || pattern.test(desc)
  );

  // If it has strong unprofessional terms and lacks overriding professional context, it's an unprofessional party
  if (hasUnprofessionalIndicators && !hasProfessionalContext) {
    return true;
  }

  // 3. Platform-specific heuristic for Partiful:
  // Partiful is overwhelmingly social/casual parties. If an event comes from Partiful
  // and has generic party/celebration words ("party", "drinks", "hangout", "celebrate")
  // without ANY professional context, treat it as an unprofessional party.
  const isPartiful =
    event.platform === "partiful" ||
    event.source === "partiful_ics" ||
    (event.url ? /partiful\.com/i.test(event.url) : false);

  if (isPartiful && !hasProfessionalContext) {
    if (/\b(?:party|celebrat|drinks|hangout|hang\s+out|dinner|rager|bash)\b/i.test(text)) {
      return true;
    }
  }

  return false;
}

/**
 * Filter an array of events into professional and unprofessional/filtered buckets.
 */
export function filterProfessionalEvents<T extends {
  title?: string | null;
  description?: string | null;
  url?: string | null;
  source?: string | null;
  platform?: string | null;
}>(events: T[]): {
  professional: T[];
  unprofessional: T[];
} {
  const professional: T[] = [];
  const unprofessional: T[] = [];

  for (const event of events) {
    if (isUnprofessionalParty(event)) {
      unprofessional.push(event);
    } else {
      professional.push(event);
    }
  }

  return { professional, unprofessional };
}
