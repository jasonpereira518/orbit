/**
 * Orbit Card, end to end against a throwaway PGlite. One section per task.
 *
 * Run: npx tsx scripts/smoke-share-card.ts
 */
import "./smoke/_env";

import { eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { shareCards, userSettings } from "../src/db/schema";
import { setSurfaceComingSoon } from "../src/lib/surface-visibility";
import {
  DEFAULT_CARD_FIELDS,
  cardUrl,
  getCardForOwner,
  loadPublicCard,
  previewCard,
  resetCardSlug,
  saveCard,
  setCardPaused,
} from "../src/lib/cards/card-store";

const PREFIX = "smoke-card-";
const OWNER = `${PREFIX}owner`;
const OPERATOR = `${PREFIX}operator`;

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function cleanup() {
  const db = await getDb();
  await db.delete(shareCards).where(like(shareCards.userId, `${PREFIX}%`));
  await db.delete(userSettings).where(like(userSettings.userId, `${PREFIX}%`));
  await setSurfaceComingSoon(OPERATOR, "page.card", true); // back to the code default
}

/** Task 3: the store and the page.card gate. */
async function cardStore() {
  console.log("\ncard store");
  const db = await getDb();
  await db.insert(userSettings).values({
    userId: OWNER,
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
    profileImageUrl: "https://img.example.com/ada.png",
    socialLinks: { linkedin: "https://linkedin.com/in/ada", website: "javascript:alert(1)" },
    careerProfile: { profile: { headline: "Analyst", location: "London" }, role: { title: "Engineer", company: "Engine Co" } },
  });
  const priorAdmins = process.env.ADMIN_USER_IDS;
  const priorClerk = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  try {
    check("first save mints an 11-character slug", (await saveCard(OWNER, { fields: DEFAULT_CARD_FIELDS, phone: null, tagline: null })).slug.length === 11);
    const { slug } = (await getCardForOwner(OWNER))!;
    check("closed surface hides the card", (await loadPublicCard(slug)) === null);

    await setSurfaceComingSoon(OPERATOR, "page.card", false);
    const card = (await loadPublicCard(slug))!;
    check("card loads once released", card?.fullName === "Ada Lovelace" && card.firstName === "Ada" && card.ownerId === OWNER);
    check("cardId is the row id", card.cardId === (await db.select().from(shareCards).where(eq(shareCards.slug, slug)))[0].id);
    check("email on, phone off by default", card.email === "ada@example.com" && card.phone === null);
    check("role and headline come from the career profile", card.title === "Engineer" && card.company === "Engine Co" && card.headline === "Analyst");
    check("website and location are off by default", card.websiteUrl === null && card.location === null);
    check("linkedin is on by default", card.linkedinUrl === "https://linkedin.com/in/ada");

    await saveCard(OWNER, { fields: { ...DEFAULT_CARD_FIELDS, location: true, website: true }, phone: null, tagline: null });
    const opted = (await loadPublicCard(slug))!;
    check("location shows once opted in; a javascript: website is dropped", opted.location === "London" && opted.websiteUrl === null);
    await db.update(userSettings).set({ socialLinks: { linkedin: "https://linkedin.com/in/ada", website: "https://ada.example.com" } }).where(eq(userSettings.userId, OWNER));
    check("an https website shows through when opted in", (await loadPublicCard(slug))!.websiteUrl === "https://ada.example.com");
    check("cardUrl", cardUrl(slug).endsWith(`/c/${slug}`));

    await saveCard(OWNER, { fields: { ...DEFAULT_CARD_FIELDS, email: false, phone: true }, phone: "  555\n0100 ", tagline: "Met at the demo" });
    const edited = (await loadPublicCard(slug))!;
    check("saving again keeps the slug", (await getCardForOwner(OWNER))!.slug === slug);
    check("hidden email is null, phone shows cleaned", edited.email === null && edited.phone === "555 0100" && edited.tagline === "Met at the demo");
    const prev = await previewCard(OWNER, { fields: DEFAULT_CARD_FIELDS, phone: "1", tagline: null });
    check("preview shows the draft without saving", prev.email === "ada@example.com" && (await getCardForOwner(OWNER))!.phone === "555 0100");

    const { slug: next } = await resetCardSlug(OWNER);
    check("reset retires the old slug", next !== slug && (await loadPublicCard(slug)) === null && (await loadPublicCard(next)) !== null);

    await setCardPaused(OWNER, true);
    check("paused card loads nothing", (await loadPublicCard(next)) === null && (await getCardForOwner(OWNER))!.pausedAt !== null);
    await setCardPaused(OWNER, false);
    check("unpaused card loads again", (await loadPublicCard(next)) !== null);

    await db.update(userSettings).set({ suspendedAt: new Date() }).where(eq(userSettings.userId, OWNER));
    check("suspended owner loads nothing", (await loadPublicCard(next)) === null);
    await db.update(userSettings).set({ suspendedAt: null }).where(eq(userSettings.userId, OWNER));

    check("bad slugs never query", (await loadPublicCard("../../etc")) === null && (await loadPublicCard("short")) === null);

    await setSurfaceComingSoon(OPERATOR, "page.card", true);
    check("re-closed surface hides the card", (await loadPublicCard(next)) === null);
    process.env.ADMIN_USER_IDS = OWNER;
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke"; // isAdminUser needs Clerk configured
    check("an operator's own card loads while closed", (await loadPublicCard(next)) !== null);
  } finally {
    if (priorAdmins === undefined) delete process.env.ADMIN_USER_IDS;
    else process.env.ADMIN_USER_IDS = priorAdmins;
    if (priorClerk === undefined) delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    else process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = priorClerk;
  }
}

async function main() {
  await cleanup();
  await cardStore();
  await cleanup();
  console.log("\nshare card: all checks passed");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => null);
  process.exit(1);
});
