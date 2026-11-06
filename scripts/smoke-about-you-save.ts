/**
 * The onboarding "About you" step's server half: the self-lookup and the confirm save.
 *
 * The heart of it is "fill only what is empty": a returning person's imported headline, typed
 * bio, schools and target priorities survive, and only an edit on the confirm screen replaces
 * the headline or the bio. Also pins that `aim` survives the export's "remove", that only
 * job-hunting aims write `roleKeywords`, that saving twice adds one goal, and that the
 * person's own brief stays off /find's Recent list.
 *
 * Local PGlite, fake researcher (no key, no network). Run: npx tsx scripts/smoke-about-you-save.ts
 */
import "./smoke/_env";
import { and, eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { aiResultCache, rateLimitBuckets, targetCompanies, userGoals, userSettings } from "../src/db/schema";
import { lookUpSelfForUser, saveAboutYouForUser, type AboutConfirm } from "../src/lib/about-you-server";
import { clearCareerProfile, loadYouCurrent } from "../src/lib/career-profile-server";
import { addTargetCompany, listTargetCompanies } from "../src/lib/events/target-companies";
import { listRecentResearch, researchPerson, type PersonResearcher } from "../src/lib/web-research";
import { run } from "./smoke/_env";

const USER = "smoke-about-you-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

function fake(answer: Record<string, unknown>): PersonResearcher {
  return async () => ({ json: JSON.stringify(answer), sources: [] });
}

const CONFIDENT = {
  match: "confident",
  name: "Ada Tester",
  headline: "CS junior at UNC",
  current: { organization: "UNC", title: "Student" },
  location: "Chapel Hill",
  summary: "Studies computer science.",
  talkingPoints: [],
  experiences: [{ kind: "education", organization: "UNC Chapel Hill", title: null, isCurrent: true }],
};

async function reset() {
  const db = await getDb();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.delete(userGoals).where(eq(userGoals.userId, USER));
  await db.delete(targetCompanies).where(eq(targetCompanies.userId, USER));
  await db.delete(aiResultCache).where(eq(aiResultCache.userId, USER));
  await db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, `%${USER}%`));
  await db.insert(userSettings).values({ userId: USER, firstName: "Ada", lastName: "Tester" });
}

function confirm(over: Partial<AboutConfirm> = {}): AboutConfirm {
  return {
    aim: "internship",
    timeline: "this_year",
    field: "product",
    companies: ["Stripe", "Figma"],
    schools: ["UNC"],
    headline: "New",
    goalSentence: "Land a product internship at Stripe or Figma this year.",
    selfIntro: "X",
    edited: { headline: false, selfIntro: false },
    prefill: null,
    ...over,
  };
}

async function main() {
  const db = await getDb();

  console.log("\nlookup");
  await reset();
  const confident = await lookUpSelfForUser(USER, "linkedin.com/in/Ada-Tester/", { researcher: fake(CONFIDENT) });
  check("a confident lookup prefills the headline", confident.status === "confident" && confident.prefill.headline === "CS junior at UNC", JSON.stringify(confident));
  check(
    "it prefills the role and schools",
    confident.status === "confident" &&
      confident.prefill.role?.company === "UNC" &&
      confident.prefill.schools.join() === "UNC Chapel Hill",
  );
  let row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, USER) });
  check("social_links.linkedin is saved normalized", row?.socialLinks?.linkedin === "https://www.linkedin.com/in/ada-tester", row?.socialLinks?.linkedin);
  check("the lookup itself writes no career_profile", row?.careerProfile == null);

  // An unrelated brief, so the Recent list is not empty only because nothing was ever looked up.
  await researchPerson(USER, { fullName: "Grace Hopper", company: "Navy" }, { researcher: fake(CONFIDENT) });
  const recent = await listRecentResearch(USER);
  check(
    "the person's own brief is not on /find's Recent list",
    recent.length === 1 && recent[0].dossier.kind === "person" && recent[0].dossier.subject.fullName === "Grace Hopper",
    JSON.stringify(recent.map((r) => r.dossier.kind === "person" ? r.dossier.subject.fullName : r.dossier.kind)),
  );

  await reset();
  const unsure = await lookUpSelfForUser(USER, "https://www.linkedin.com/in/ada-tester", {
    researcher: fake({ ...CONFIDENT, match: "unsure" }),
  });
  check("an unsure lookup says unsure", unsure.status === "unsure", JSON.stringify(unsure));
  row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, USER) });
  check("and writes nothing to career_profile", row?.careerProfile == null);

  await reset();
  const thrown = await lookUpSelfForUser(USER, "https://www.linkedin.com/in/ada-tester", {
    researcher: async () => {
      throw new Error("provider down");
    },
  });
  check("a provider failure is unavailable", thrown.status === "unavailable");

  await db.update(userSettings).set({ firstName: null, lastName: null }).where(eq(userSettings.userId, USER));
  const nameless = await lookUpSelfForUser(USER, "https://www.linkedin.com/in/ada-tester", { researcher: fake(CONFIDENT) });
  check("no name on file is unavailable", nameless.status === "unavailable");

  console.log("\nreturning person");
  await reset();
  await db
    .update(userSettings)
    .set({
      careerProfile: { profile: { headline: "Imported" }, skills: ["Go"] },
      senderBio: "Mine",
      schools: ["Duke"],
    })
    .where(eq(userSettings.userId, USER));
  await addTargetCompany(USER, "Stripe", 3);
  await saveAboutYouForUser(USER, confirm());
  let cur = await loadYouCurrent(USER);
  check("an imported headline is kept", cur.career?.profile?.headline === "Imported", JSON.stringify(cur.career));
  check("other career keys are untouched", cur.career?.skills?.join() === "Go");
  check("a typed bio is kept", cur.senderBio === "Mine");
  check("schools are merged, never replaced", cur.schools.join() === "Duke,UNC", cur.schools.join());
  const targets = await listTargetCompanies(USER);
  const priority = (name: string) => targets.find((t) => t.name === name)?.priority;
  check("an existing target keeps its priority", priority("Stripe") === 3, JSON.stringify(targets));
  check("a new target is priority 1", priority("Figma") === 1);
  check("the aim is stored", cur.career?.aim?.kind === "internship" && cur.career.aim.field === "product" && !!cur.career.aim.setAt);
  check("an internship appends the field's title", cur.career?.roleKeywords?.join() === "Product Manager");

  await saveAboutYouForUser(USER, confirm());
  cur = await loadYouCurrent(USER);
  const goals = await db.select().from(userGoals).where(and(eq(userGoals.userId, USER), eq(userGoals.active, 1)));
  check("saving twice leaves exactly one goal", goals.length === 1, String(goals.length));
  check("and the title once", cur.career?.roleKeywords?.join() === "Product Manager", cur.career?.roleKeywords?.join());

  await saveAboutYouForUser(USER, confirm({ edited: { headline: true, selfIntro: true } }));
  cur = await loadYouCurrent(USER);
  check("an edited headline replaces the imported one", cur.career?.profile?.headline === "New");
  check("an edited self-intro replaces the bio", cur.senderBio === "X");

  console.log("\nempty fields fill from the lookup");
  await reset();
  await saveAboutYouForUser(
    USER,
    confirm({
      headline: "CS junior at UNC",
      prefill: { headline: "CS junior at UNC", role: { title: "Student", company: "UNC" }, location: "Chapel Hill", summary: "Studies.", schools: [] },
    }),
  );
  cur = await loadYouCurrent(USER);
  check("headline, location and summary fill", cur.career?.profile?.headline === "CS junior at UNC" && cur.career.profile.location === "Chapel Hill" && cur.career.profile.summary === "Studies.");
  check("the role fills", cur.career?.role?.company === "UNC");
  check("an empty bio takes the self-intro", cur.senderBio === "X");

  console.log("\naims that are not job-hunting");
  await reset();
  await saveAboutYouForUser(USER, confirm({ aim: "grow" }));
  cur = await loadYouCurrent(USER);
  check("grow leaves roleKeywords unchanged", cur.career?.roleKeywords === undefined, JSON.stringify(cur.career?.roleKeywords));

  console.log("\nthe export's remove keeps the aim");
  await clearCareerProfile(USER);
  cur = await loadYouCurrent(USER);
  check("aim is kept", cur.career?.aim?.kind === "grow", JSON.stringify(cur.career));
  check("profile is dropped", cur.career?.profile === undefined);

  await reset();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  console.log(failures ? `\n${failures} check(s) failed` : "\nsmoke-about-you-save: all checks passed");
  if (failures) process.exit(1);
}

run(main);
