import assert from "node:assert/strict";
import { isUnprofessionalParty, filterProfessionalEvents } from "../src/lib/events/professional-filter";

console.log("\ndetecting unprofessional party and casual social events");

const unprofessionalCases = [
  { title: "Sarah's 30th Birthday Party" },
  { title: "Dave's Bday Bash & Beer Pong" },
  { title: "Mike & Jessica's Wedding Reception" },
  { title: "Bachelorette Party in Vegas" },
  { title: "Baby Shower for Emma" },
  { title: "Housewarming Party at our new apartment" },
  { title: "Austin Downtown Pub Crawl" },
  { title: "Sigma Chi Frat Party" },
  { title: "Super Bowl Tailgate Party" },
  { title: "Casual Hangout and Drinks", platform: "partiful" },
  { title: "Friday Night Rager", source: "partiful_ics" },
];

for (const c of unprofessionalCases) {
  const isParty = isUnprofessionalParty(c);
  assert.equal(isParty, true, `Should have flagged as unprofessional: ${c.title}`);
  console.log(`  ok    flagged unprofessional party: "${c.title}"`);
}

console.log("\npreserving strictly professional events (including professional mixers and launch parties)");

const professionalCases = [
  { title: "AI Engineering Summit 2026" },
  { title: "YC Demo Day Afterparty" },
  { title: "Tech Week Founder Launch Party" },
  { title: "San Francisco React Developers Meetup" },
  { title: "Autonomous Agents Hackathon" },
  { title: "B2B SaaS Founders Breakfast" },
  { title: "Venture Capital & Angel Investor Panel" },
  { title: "Cloud Architecture Fireside Chat" },
  { title: "Biotech & Healthcare Symposium" },
];

for (const c of professionalCases) {
  const isParty = isUnprofessionalParty(c);
  assert.equal(isParty, false, `Should NOT have flagged as unprofessional: ${c.title}`);
  console.log(`  ok    preserved professional event: "${c.title}"`);
}

console.log("\npartitioning event lists into professional and hidden pools");

const mixedEvents = [
  { id: "1", title: "AI Summit 2026" },
  { id: "2", title: "Bobby's 21st Birthday" },
  { id: "3", title: "Founders Pitch Night" },
  { id: "4", title: "Saturday Bar Crawl" },
];

const { professional, unprofessional } = filterProfessionalEvents(mixedEvents);
assert.equal(professional.length, 2);
assert.equal(unprofessional.length, 2);
assert.deepEqual(
  professional.map((e) => e.id),
  ["1", "3"]
);
assert.deepEqual(
  unprofessional.map((e) => e.id),
  ["2", "4"]
);
console.log("  ok    correctly separated 2 professional and 2 unprofessional events");

console.log("\nAll professional filter checks passed.");
