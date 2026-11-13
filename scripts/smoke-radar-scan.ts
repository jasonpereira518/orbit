/**
 * Radar PR 11: the extension's "Scan this page for people I know", and the hashtags from your
 * own LinkedIn posts (Shares.csv).
 *
 *   - The scanner reads only a feed or an activity page; it takes each post's author from its
 *     header (never a commenter), skips company posts and empty ones, and caps at 25.
 *   - The server matches authors to contacts by LinkedIn profile only (never by name), keeps
 *     nothing about the rest, and stores only contacts' posts, once each, with a LinkedIn link
 *     or none.
 *   - Shares.csv: hashtags from the last two years used at least twice, at most eight, both of
 *     LinkedIn's spellings; saved on the career profile and cleared with imported details.
 *
 * Writes to local PGlite. Run: npx tsx scripts/smoke-radar-scan.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { gzipSync } from "node:zlib";
import { and, eq } from "drizzle-orm";
import { parseHTML } from "linkedom";
import { getDb } from "../src/db";
import { contactSignals, importFiles, imports, userSettings } from "../src/db/schema";
import { clearCareerProfile } from "../src/lib/career-profile-server";
import { resolveOrCreateContact } from "../src/lib/contact-resolve";
import { applyShareTopics, shareTopics } from "../src/lib/linkedin-shares";
import { matchScannedAuthors, saveScannedPosts } from "../src/lib/radar/signals/activity";
import { ensureUserSettings } from "../src/lib/user-settings";
import { checker } from "./smoke/check";

// extension/ never reaches a Vercel build (.vercelignore), and that build typechecks scripts/,
// so the content-script adapter is loaded at run time against this copy of its surface.
type ScannedPost = { authorProfileUrl: string; authorName: string | null; excerpt: string; url: string | null };
type ScanAdapter = {
  isScanPath(pathname: string): boolean;
  scanLinkedinPosts(root: ParentNode, pageUrl: URL): ScannedPost[];
  SCAN_MAX_POSTS: number;
};
const SCAN_ADAPTER = "../extension/src/inject/adapters/linkedin-scan";
import { fakeUserId, purgeUsers } from "./smoke/factories";

const t = checker();

function post(urn: string, actorHref: string | null, name: string, body: string, comment = "") {
  const actor = actorHref
    ? `<div class="update-components-actor"><a class="update-components-actor__meta-link" href="${actorHref}"><span class="update-components-actor__title"><span aria-hidden="true">${name}</span></span></a></div>`
    : "";
  return `<div data-urn="${urn}"><div class="feed-shared-update-v2">${actor}<div class="update-components-text">${body}</div>${comment}</div></div>`;
}

run(async () => {
  const { isScanPath, scanLinkedinPosts, SCAN_MAX_POSTS } = (await import(SCAN_ADAPTER)) as ScanAdapter;
  console.log("the scanner");
  const comment = `<div class="comments-comments-list"><a href="https://www.linkedin.com/in/commenter-bo/">Bo</a> Great post</div>`;
  const feed = parseHTML(
    `<main>${[
      post("urn:li:activity:111", "https://www.linkedin.com/in/ana-lee/?miniProfileUrn=x", "Ana Lee", "Shipped our   new  storage pilot"),
      post("urn:li:activity:222", "https://www.linkedin.com/in/stranger-sam/", "Sam Stranger", "Hiring!", comment),
      post("urn:li:activity:333", "https://www.linkedin.com/company/acme/", "Acme", "Our quarterly update"),
      post("urn:li:activity:444", "https://www.linkedin.com/in/ana-lee/", "Ana Lee", ""),
      post("urn:li:activity:111", "https://www.linkedin.com/in/ana-lee/", "Ana Lee", "Shipped our new storage pilot"),
    ].join("")}</main>`
  ).document;
  const found = scanLinkedinPosts(feed, new URL("https://www.linkedin.com/feed/"));
  t.check("reads each post once, from its header", found.length === 2, JSON.stringify(found));
  t.check("the author is the poster, not a commenter", found[1]?.authorProfileUrl === "https://www.linkedin.com/in/stranger-sam");
  t.check("company posts and empty ones are skipped", !found.some((p) => p.authorProfileUrl.includes("acme")));
  t.check("text is one line, and the post links to itself", found[0]?.excerpt === "Shipped our new storage pilot" && found[0]?.url === "https://www.linkedin.com/feed/update/urn:li:activity:111/");
  t.check("nothing is read on a profile or a post page", scanLinkedinPosts(feed, new URL("https://www.linkedin.com/in/ana-lee/")).length === 0);
  t.check("scan pages are the feed and activity pages", isScanPath("/feed/") && isScanPath("/in/ana-lee/recent-activity/all/") && !isScanPath("/feed/update/urn:li:activity:1/"));
  const activity = parseHTML(`<main>${post("urn:li:activity:555", null, "", "A talk I gave")}</main>`).document;
  const own = scanLinkedinPosts(activity, new URL("https://www.linkedin.com/in/ana-lee/recent-activity/all/"));
  t.check("on an activity page a post with no header is the page owner's", own[0]?.authorProfileUrl === "https://www.linkedin.com/in/ana-lee");
  const many = parseHTML(`<main>${Array.from({ length: 40 }, (_, i) => post(`urn:li:activity:${1000 + i}`, "https://www.linkedin.com/in/ana-lee/", "Ana", `Post ${i}`)).join("")}</main>`).document;
  t.check(`never more than ${SCAN_MAX_POSTS} posts`, scanLinkedinPosts(many, new URL("https://www.linkedin.com/feed/")).length === SCAN_MAX_POSTS);

  const db = await getDb();
  const USER = fakeUserId("radar-scan");
  const OTHER = fakeUserId("radar-scan-other");
  try {
    await ensureUserSettings(USER);
    await ensureUserSettings(OTHER);
    const opts = { skipRevalidate: true, skipEmbedding: true, skipSummary: true } as const;
    const ana = await resolveOrCreateContact(USER, { fullName: "Ana Lee", linkedinUrl: "https://www.linkedin.com/in/ana-lee/" }, opts);
    // Same name as a stranger on the feed, different profile: never a match.
    await resolveOrCreateContact(USER, { fullName: "Sam Stranger", linkedinUrl: "https://www.linkedin.com/in/sam-stranger-real/" }, opts);

    console.log("\nthe server");
    const matched = await matchScannedAuthors(USER, ["https://www.linkedin.com/in/ana-lee", "https://www.linkedin.com/in/stranger-sam", "https://www.linkedin.com/in/nobody"]);
    t.check("only a contact's profile matches; a namesake's does not", matched.length === 1 && matched[0]?.contactId === ana.contactId && matched[0]?.name === "Ana Lee", JSON.stringify(matched));
    t.check("another account matches nobody", (await matchScannedAuthors(OTHER, ["https://www.linkedin.com/in/ana-lee"])).length === 0);

    const first = await saveScannedPosts(USER, [
      { authorProfileUrl: "https://www.linkedin.com/in/ana-lee", excerpt: "Shipped our new storage pilot", url: "https://www.linkedin.com/feed/update/urn:li:activity:111/" },
      { authorProfileUrl: "https://www.linkedin.com/in/stranger-sam", excerpt: "Hiring!", url: "https://www.linkedin.com/feed/update/urn:li:activity:222/" },
      { authorProfileUrl: "https://www.linkedin.com/in/ana-lee", excerpt: "A post with an odd link", url: "https://evil.example.com/x" },
    ]);
    const rows = await db.select().from(contactSignals).where(eq(contactSignals.userId, USER));
    t.check("only the contact's posts are kept; the stranger's is dropped", first.saved === 2 && rows.length === 2 && rows.every((r) => r.contactId === ana.contactId), JSON.stringify(first));
    t.check("kept as Radar's LinkedIn activity", rows.every((r) => r.kind === "linkedin_activity"));
    t.check("a link that isn't LinkedIn's is not stored", rows.some((r) => r.payload.excerpt === "A post with an odd link" && !r.payload.url));
    t.check("the panel learns who they were by", first.people.join() === "Ana Lee");
    const again = await saveScannedPosts(USER, [{ authorProfileUrl: "https://www.linkedin.com/in/ana-lee/", excerpt: "Shipped our new storage pilot", url: "https://www.linkedin.com/feed/update/urn:li:activity:111/" }]);
    t.check("scanning the same post again keeps it once", again.saved === 0 && again.duplicate === 1);

    console.log("\nyour own posts' hashtags");
    const recent = "2026-10-01 10:00:00";
    const csv = [
      "Date,ShareLink,ShareCommentary,SharedUrl,MediaUrl,Visibility",
      `${recent},https://x,"Big week for {hashtag|\\#|ClimateTech} and #GridStorage",,,MEMBER_NETWORK`,
      `${recent},https://x,"More #climatetech news, #1 day ever #GridStorage",,,MEMBER_NETWORK`,
      `${recent},https://x,"#Fintech once only",,,MEMBER_NETWORK`,
      `2020-01-01 10:00:00,https://x,"#OldTopic #OldTopic #OldTopic",,,MEMBER_NETWORK`,
      `2020-02-01 10:00:00,https://x,"#OldTopic again",,,MEMBER_NETWORK`,
    ].join("\n");
    const topics = shareTopics(csv, new Date("2026-11-12T12:00:00Z"));
    t.check("hashtags used twice in two years, both spellings, most used first", topics.join() === "ClimateTech,GridStorage", topics.join());

    const [imp] = await db.insert(imports).values({ userId: USER, importType: "linkedin_export" }).returning();
    await db.insert(importFiles).values({ userId: USER, importId: imp!.id, path: "Shares.csv", byteSize: csv.length, role: "stored", gz: gzipSync(Buffer.from(csv)).toString("base64") });
    await applyShareTopics(USER, imp!.id, new Date("2026-11-12T12:00:00Z"));
    const [withTopics] = await db.select({ career: userSettings.careerProfile }).from(userSettings).where(eq(userSettings.userId, USER));
    t.check("an export's Shares.csv sets the topics on the career profile", withTopics?.career?.postTopics?.join() === "ClimateTech,GridStorage", JSON.stringify(withTopics?.career));
    await clearCareerProfile(USER);
    const [cleared] = await db.select({ career: userSettings.careerProfile }).from(userSettings).where(eq(userSettings.userId, USER));
    t.check("“Remove imported details” clears them", !cleared?.career?.postTopics);
    await db.delete(importFiles).where(and(eq(importFiles.userId, USER), eq(importFiles.importId, imp!.id)));
    await applyShareTopics(USER, imp!.id);
    const [none] = await db.select({ career: userSettings.careerProfile }).from(userSettings).where(eq(userSettings.userId, USER));
    t.check("an export without Shares.csv leaves no topics", !none?.career?.postTopics);
  } finally {
    await purgeUsers(db, [USER, OTHER]);
  }

  t.done("radar scan");
});
