/**
 * Saving what a LinkedIn export says about the user: the per-key merge into
 * `user_settings.career_profile` and the rule that `sender_bio` (what the person typed) is
 * only ever written when the patch carries one.
 *
 * Local PGlite. Run: npx tsx scripts/smoke-linkedin-you-db.ts
 */
import "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { patchYou } from "../src/lib/career-profile";
import { clearCareerProfile, loadYouCurrent, saveCareerPatch } from "../src/lib/career-profile-server";
import { run } from "./smoke/_env";

const USER = "smoke-career-user";
const OTHER = "smoke-career-other";
const NOW = new Date("2026-10-08T12:00:00Z");

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const PROFILE =
  "First Name,Last Name,Maiden Name,Address,Birth Date,Headline,Summary,Industry,Zip Code,Geo Location,Twitter Handles,Websites,Instant Messengers\nAda,T,,,,Backend engineer,,Technology,,Arlington,,,\n";
const SKILLS = "Name\nGo\nPython\n";
const POSITIONS = "Company Name,Title,Description,Location,Started On,Finished On\nAcme,Engineer,,,May 2026,\n";

async function apply(target: Parameters<typeof patchYou>[0], text: string, keys: string[]) {
  const patch = patchYou(target, text, keys, await loadYouCurrent(USER), NOW);
  if (!patch) throw new Error("no patch");
  await saveCareerPatch(USER, patch);
}

async function main() {
  const db = await getDb();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, OTHER));

  console.log("a first import into an account with no settings row");
  await apply("linkedin_profile", PROFILE, ["profile.headline", "profile.industry"]);
  let cur = await loadYouCurrent(USER);
  check("the row is created with the headline and industry", cur.career?.profile?.headline === "Backend engineer" && cur.career?.profile?.industry === "Technology", JSON.stringify(cur.career));
  check("sender_bio is untouched (still empty)", cur.senderBio === null);

  console.log("\nanother file merges instead of replacing");
  await apply("linkedin_skills", SKILLS, ["skills"]);
  await apply("linkedin_positions", POSITIONS, ["role"]);
  cur = await loadYouCurrent(USER);
  check("the headline survives the skills and role imports", cur.career?.profile?.headline === "Backend engineer");
  check("skills and role are there", cur.career?.skills?.join() === "Go,Python" && cur.career?.role?.company === "Acme");

  console.log("\nwhat the person typed");
  await db.update(userSettings).set({ senderBio: "I am a founder looking for design partners" }).where(eq(userSettings.userId, USER));
  await apply("linkedin_profile", PROFILE, ["profile.industry"]);
  cur = await loadYouCurrent(USER);
  check("re-importing the profile without 'about' ticked keeps the typed line", cur.senderBio === "I am a founder looking for design partners");
  await apply("linkedin_profile", PROFILE, ["about"]);
  cur = await loadYouCurrent(USER);
  check("with 'about' ticked it is replaced by the headline", cur.senderBio === "Backend engineer");

  console.log("\nanother account is never touched");
  check("someone else has nothing", (await loadYouCurrent(OTHER)).career === null);

  console.log("\nremoving it");
  await clearCareerProfile(USER);
  cur = await loadYouCurrent(USER);
  check("the imported details are gone", cur.career === null);
  check("the line they typed is kept", cur.senderBio === "Backend engineer");

  console.log("\nthe full history (deep read)");
  const histPatch = patchYou("linkedin_positions", POSITIONS, ["role", "positions"], await loadYouCurrent(USER), NOW, { history: true });
  await saveCareerPatch(USER, histPatch!);
  cur = await loadYouCurrent(USER);
  check("history is stored on career_profile", cur.career?.positions?.length === 1 && cur.career?.positions?.[0].start?.year === 2026, JSON.stringify(cur.career));
  await clearCareerProfile(USER);
  const cleared = (await loadYouCurrent(USER)).career;
  check("Remove imported details clears the history", cleared?.positions === undefined && cleared?.education === undefined, JSON.stringify(cleared));
  await saveCareerPatch(USER, { career: { positions: histPatch!.career.positions, historyCheckedAt: NOW.toISOString() }, senderBio: null, schools: null, message: "" });
  await clearCareerProfile(USER);
  const stamped = (await loadYouCurrent(USER)).career;
  check("…and keeps the catch-up's stamp, so the history is not written back", stamped?.positions === undefined && stamped?.historyCheckedAt === NOW.toISOString(), JSON.stringify(stamped));

  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  console.log(failures ? `\n${failures} check(s) failed` : "\nsmoke-linkedin-you-db: all checks passed");
  if (failures) process.exit(1);
}

run(main);
