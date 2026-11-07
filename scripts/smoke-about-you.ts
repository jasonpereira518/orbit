/**
 * The onboarding "About you" step's pure logic: reading the person's own LinkedIn URL and
 * turning their goal taps into the one-line goal and self-intro the rest of the app shows.
 *
 * Run: npx tsx scripts/smoke-about-you.ts
 */
import {
  TIMELINE_LABELS,
  asksForMajors,
  composeGoalSentence,
  buildDiscoveryQuery,
  composeSelfIntro,
  isJobHuntingAim,
  parseOwnLinkedInUrl,
  type AboutAnswers,
} from "../src/lib/about-you";

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) return console.log(`  ok  ${label}`);
  failures += 1;
  console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
}

const empty: AboutAnswers = {
  aim: null,
  timeline: null,
  field: null,
  companies: [],
  schools: [],
  majors: [],
  headline: null,
};

console.log("\nparseOwnLinkedInUrl");
{
  const r = parseOwnLinkedInUrl("linkedin.com/in/jane-doe-123?trk=x");
  check("bare host + query parses", r.ok && r.slug === "jane-doe-123");
  check("canonical url", r.ok && r.url === "https://www.linkedin.com/in/jane-doe-123");
  check("company page rejected", !parseOwnLinkedInUrl("https://www.linkedin.com/company/stripe").ok);
  check("bare word rejected", !parseOwnLinkedInUrl("jane").ok);
  check("lookalike host rejected", !parseOwnLinkedInUrl("https://notlinkedin.com/in/jane").ok);
  check("empty rejected", !parseOwnLinkedInUrl("  ").ok);
}

console.log("\ncomposeGoalSentence");
{
  const s = composeGoalSentence({
    ...empty,
    aim: "internship",
    field: "product",
    companies: ["Stripe", "Figma"],
    timeline: "this_year",
  });
  check("internship example", s === "Land a product internship at Stripe or Figma in the next year.", String(s));
  const soon = composeGoalSentence({ ...empty, aim: "internship", field: "software", timeline: "this_term" });
  check("this_term reads as soon as possible", soon === "Land a software internship as soon as possible.", String(soon));
  const later = composeGoalSentence({ ...empty, aim: "build", timeline: "no_rush" });
  check("no_rush adds no time clause", later === "Build something.", String(later));
  const e = composeGoalSentence({ ...empty, aim: "explore", timeline: "no_rush" });
  check("explore has no dangling at / this", !!e && !/\bat\b|this /.test(e) && e.endsWith("."), String(e));
  check("null aim -> null", composeGoalSentence(empty) === null);
}

console.log("\ncomposeSelfIntro");
{
  const s = composeSelfIntro({ ...empty, headline: "CS junior at UNC", aim: "internship", field: "product" });
  check("headline + aim", s === "CS junior at UNC, aiming for product internships.", String(s));
  check("all empty -> null", composeSelfIntro(empty) === null);
  const m = composeSelfIntro({
    ...empty,
    majors: ["Computer Science", "Economics"],
    schools: ["UNC", "Duke"],
    headline: "Ignored headline",
    aim: "internship",
    field: "software",
  });
  check("majors + school win over the headline", m === "Computer Science and Economics student at UNC, aiming for software internships.", String(m));
  const noSchool = composeSelfIntro({ ...empty, majors: [" Math "], aim: null });
  check("majors without a school", noSchool === "Math student.", String(noSchool));
  const blank = composeSelfIntro({ ...empty, majors: ["  "], headline: "PM at Stripe", aim: "grow" });
  check("blank majors fall back to the headline", blank === "PM at Stripe, growing where they are.", String(blank));
}

console.log("\nTIMELINE_LABELS");
check("this_term", TIMELINE_LABELS.this_term === "As soon as possible");
check("this_year", TIMELINE_LABELS.this_year === "In the next year");
check("no_rush", TIMELINE_LABELS.no_rush === "In the future");

console.log("\nasksForMajors");
check("internship asks for majors", asksForMajors("internship"));
check("no aim asks for majors", asksForMajors(null));
check("full_time / switch_roles / grow keep the headline row",
  !asksForMajors("full_time") && !asksForMajors("switch_roles") && !asksForMajors("grow"));

console.log("\nisJobHuntingAim");
check("grow false", isJobHuntingAim("grow") === false);
check("switch_roles true", isJobHuntingAim("switch_roles") === true);

console.log("\nbuildDiscoveryQuery");
{
  const aim = (field: "product" | null) => ({ kind: "internship" as const, timeline: "this_year" as const, field, setAt: "2026-11-06" });
  const q = buildDiscoveryQuery({ aim: aim("product"), companies: ["Stripe", "Figma"], schools: ["UNC"] });
  check("school + field + companies", q === "UNC alumni working in product at Stripe or Figma", String(q));
  const n = buildDiscoveryQuery({ aim: aim("product"), companies: ["Stripe", "Figma"], schools: [] });
  check("no school", n === "People working in product at Stripe or Figma", String(n));
  check("nothing -> null", buildDiscoveryQuery({ aim: null, companies: [], schools: [] }) === null);
  const c = buildDiscoveryQuery({ aim: aim("product"), companies: ["A", "B", "C", "D"], schools: [] });
  check("companies capped at 3", c === "People working in product at A, B, or C", String(c));
  const f = buildDiscoveryQuery({ aim: aim(null), companies: [], schools: [] });
  check("aim only -> null", f === null, String(f));
  const s = buildDiscoveryQuery({ aim: null, companies: [], schools: ["UNC"] });
  check("school only", s === "UNC alumni", String(s));
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed\n`);
  process.exit(1);
}
console.log("\nAll About-you checks passed\n");
process.exit(0);
