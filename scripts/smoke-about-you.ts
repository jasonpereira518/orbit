/**
 * The onboarding "About you" step's pure logic: reading the person's own LinkedIn URL and
 * turning their goal taps into the one-line goal and self-intro the rest of the app shows.
 *
 * Run: npx tsx scripts/smoke-about-you.ts
 */
import {
  composeGoalSentence,
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
  check("internship example", s === "Land a product internship at Stripe or Figma this year.", String(s));
  const e = composeGoalSentence({ ...empty, aim: "explore", timeline: "no_rush" });
  check("explore has no dangling at / this", !!e && !/\bat\b|this /.test(e) && e.endsWith("."), String(e));
  check("null aim -> null", composeGoalSentence(empty) === null);
}

console.log("\ncomposeSelfIntro");
{
  const s = composeSelfIntro({ ...empty, headline: "CS junior at UNC", aim: "internship", field: "product" });
  check("headline + aim", s === "CS junior at UNC, aiming for product internships.", String(s));
  check("all empty -> null", composeSelfIntro(empty) === null);
}

console.log("\nisJobHuntingAim");
check("grow false", isJobHuntingAim("grow") === false);
check("switch_roles true", isJobHuntingAim("switch_roles") === true);

if (failures > 0) {
  console.log(`\n${failures} check(s) failed\n`);
  process.exit(1);
}
console.log("\nAll About-you checks passed\n");
process.exit(0);
