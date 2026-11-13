/**
 * The writing style learned from sent mail (`src/lib/writing-style-profile.ts`):
 * what of a sent email is kept as a sample, what of the model's profile is stored, how it joins
 * the user's own notes for drafts (their notes first; nothing at all when both are empty), and
 * the column's three states: NULL builds lazily, "" (turned off) never does, and a mailbox-less
 * attempt is not retried for a week.
 *
 * Local PGlite, no provider. Run: npx tsx scripts/smoke-writing-style-profile.ts
 */
import "./smoke/_env";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { STYLE_PROFILE_MAX, withStyleProfile } from "../src/lib/writing-instructions";
import { loadOwnWritingInstructions, loadWritingInstructions } from "../src/lib/writing-instructions-store";
import { buildStyleProfile, cleanProfile, cleanSentBody, maybeBuildStyleProfile } from "../src/lib/writing-style-profile";

const USER = "smoke-style-profile-user";
let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const OWN =
  "Hey Sam,\n\nThanks for the intro to the infra team, that was really kind of you. I sent Priya a note this morning and we're meeting Thursday to walk through the payments roadmap and what an intern would own.\n\nWill let you know how it goes.\n\nJason";

async function main() {
  console.log("cleaning a sent email");
  const reply = `${OWN}\n\nOn Tue, Nov 11, 2026 at 3:02 PM Sam Lee <sam@example.com> wrote:\n> Happy to help, here is Priya\n> priya@stripe.com`;
  check("a quoted reply is cut off", cleanSentBody(reply) === cleanSentBody(OWN));
  check("a wrapped 'On … wrote:' line is cut too", !/Happy/.test(cleanSentBody(`${OWN}\n\nOn Tue, Nov 11, 2026 at 3:02 PM Sam Lee <\nsam@example.com> wrote:\n> Happy`) ?? "Happy"));
  check("a signature after '-- ' is cut", !/CEO/.test(cleanSentBody(`${OWN}\n-- \nJason Pereira | CEO, Orbit\nOffice hours Tuesday`) ?? "CEO"));
  check("'Sent from my iPhone' is cut", !/iPhone/.test(cleanSentBody(`${OWN}\n\nSent from my iPhone`) ?? "iPhone"));
  check("a forward is cut", !/Fwd body/.test(cleanSentBody(`${OWN}\n\n---------- Forwarded Message ----------\nFwd body`) ?? "Fwd body"));
  const contact = cleanSentBody(`${OWN} Reach me at jason@orbit.app or +1 (919) 555-0100, deck at https://orbit.app/deck.`) ?? "";
  check("addresses, links and phone numbers are blanked", !/@|https?:|555/.test(contact), contact);
  check("a one-liner is too little to learn from", cleanSentBody("Sounds good, thanks!") === null);
  check("a long email is cut to 1,200 characters", Array.from(cleanSentBody(`${OWN} ${"word ".repeat(600)}`) ?? "").length <= 1200);

  console.log("\nthe stored profile");
  check("contact detail is stripped from the profile", !/@|http/.test(cleanProfile("- Signs off 'Jason' (jason@orbit.app), links https://x.co") ?? ""));
  const long = cleanProfile("- short sentences\n".repeat(80)) ?? "";
  check(`capped at ${STYLE_PROFILE_MAX} characters, ending on a whole word`, Array.from(long).length <= STYLE_PROFILE_MAX && long.endsWith("sentences"), long.slice(-20));
  check("empty stays empty", cleanProfile("   ") === null);
  check("a <name> placeholder survives as {name}", cleanProfile("- Opens with 'Hey <first name>,'") === "- Opens with 'Hey {first name},'");

  console.log("\njoined with the user's notes");
  check("neither: nothing (prompts stay byte-identical)", withStyleProfile(null, null) === null && withStyleProfile("", "") === null);
  check("notes only: the notes", withStyleProfile("Keep it short.", null) === "Keep it short.");
  check("a turned-off profile adds nothing", withStyleProfile("Keep it short.", "") === "Keep it short.");
  const both = withStyleProfile("Keep it short.", "- Opens with 'Hey {name},'") ?? "";
  check("both: notes first, then the learned style, labelled", both.startsWith("Keep it short.\n\nHow they write, learned from their own sent mail") && both.endsWith("- Opens with 'Hey {name},'"), both);

  console.log("\nthe column's states");
  const db = await getDb();
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await db.insert(userSettings).values({ userId: USER, writingInstructions: "Keep it short.", writingStyleProfile: "- Opens with 'Hey {name},'" });
  check("drafts read notes + profile", (await loadWritingInstructions(USER)) === both);
  check("the notes box reads only the notes", (await loadOwnWritingInstructions(USER)) === "Keep it short.");

  await db.update(userSettings).set({ writingStyleProfile: "", writingStyleProfileUpdatedAt: null }).where(eq(userSettings.userId, USER));
  await maybeBuildStyleProfile(USER);
  const off = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, USER) });
  check("turned off: the lazy build never runs", off?.writingStyleProfile === "" && off?.writingStyleProfileUpdatedAt === null);

  await db.update(userSettings).set({ writingStyleProfile: null }).where(eq(userSettings.userId, USER));
  const res = await buildStyleProfile(USER);
  const tried = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, USER) });
  check("no mailbox: says so, stores nothing, stamps the attempt", res.status === "no_mailbox" && tried?.writingStyleProfile === null && tried?.writingStyleProfileUpdatedAt instanceof Date);
  const before = tried?.writingStyleProfileUpdatedAt?.getTime();
  await maybeBuildStyleProfile(USER);
  const again = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, USER) });
  check("tried this week: the lazy build waits", again?.writingStyleProfileUpdatedAt?.getTime() === before);

  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll writing style profile checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
