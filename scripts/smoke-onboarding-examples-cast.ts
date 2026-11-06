/**
 * The guided tour's example cast, as invariants. Every stop of the in-app tour leans on one
 * of these — an overdue follow-up for the dashboard, a reminder due today, a three-person
 * company cluster for the Constellation — and the identities must be ones no real import can
 * ever collide with.
 *
 * Run: npx tsx scripts/smoke-onboarding-examples-cast.ts
 */
import {
  EXAMPLE_COMPANY,
  EXAMPLE_COMPANY_NAMES,
  EXAMPLE_FULL_NAMES,
  EXAMPLE_PEOPLE,
  TOUR_EXAMPLE_NOTE,
} from "../src/lib/onboarding-examples/cast";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function main() {
  console.log("Onboarding example cast…");

  check("six people", EXAMPLE_PEOPLE.length === 6);
  check("keys are unique", new Set(EXAMPLE_PEOPLE.map((p) => p.key)).size === 6);
  check("names are unique", new Set(EXAMPLE_FULL_NAMES).size === 6);

  console.log("\nidentities can never collide with a real import");
  check("emails are unique", new Set(EXAMPLE_PEOPLE.map((p) => p.email)).size === 6);
  check("every email is on example.com", EXAMPLE_PEOPLE.every((p) => p.email.endsWith("@example.com")));
  check("slugs are unique", new Set(EXAMPLE_PEOPLE.map((p) => p.linkedinSlug)).size === 6);
  check("every slug starts with orbit-example-", EXAMPLE_PEOPLE.every((p) => p.linkedinSlug.startsWith("orbit-example-")));

  console.log("\nthe timeline is in the recent past");
  for (const p of EXAMPLE_PEOPLE) {
    check(`${p.firstName} has at least one touch`, p.touches.length > 0);
    check(`${p.firstName}'s touches are 1–60 days ago`, p.touches.every((t) => t.at >= 1 && t.at <= 60), JSON.stringify(p.touches.map((t) => t.at)));
    check(`${p.firstName} was met on or before the first touch`, p.touches.every((t) => t.at <= p.metDaysAgo));
    check(`${p.firstName}'s closeness is 1–5`, p.closeness >= 1 && p.closeness <= 5);
  }

  console.log("\nwhat each tour stop needs");
  const cluster = EXAMPLE_PEOPLE.filter((p) => p.company === EXAMPLE_COMPANY);
  check("three people share the first company (the Constellation cluster)", cluster.length >= 3);
  const reminders = EXAMPLE_PEOPLE.flatMap((p) => (p.reminder ? [p.reminder] : []));
  check("exactly one overdue reminder", reminders.filter((r) => r.inDays < 0).length === 1);
  check("exactly one reminder due today", reminders.filter((r) => r.inDays === 0).length === 1);
  check("exactly one upcoming reminder", reminders.filter((r) => r.inDays > 0).length === 1);
  check("someone is overdue for a follow-up (the dashboard's due card)", EXAMPLE_PEOPLE.some((p) => p.followUpInDays != null && p.followUpInDays < 0));
  check("the capture note names a cast member", EXAMPLE_FULL_NAMES.some((n) => TOUR_EXAMPLE_NOTE.includes(n)));
  check("the capture note names the first company", TOUR_EXAMPLE_NOTE.includes(EXAMPLE_COMPANY));
  check("every company the cast uses is on the removal list", EXAMPLE_PEOPLE.every((p) => p.company == null || EXAMPLE_COMPANY_NAMES.includes(p.company)));

  console.log("\nAll example cast checks passed.");
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error("\nFAILED:", e);
  process.exit(1);
}
