/**
 * Read path of the shared LinkedIn photo cache: every reader that goes through
 * `clientAvatarUrlSql` / `sharedAvatarUrlSql` prefers the shared row, in a plain select, a
 * relational query's `extras`, and raw SQL alike.
 *
 * Run: npx tsx scripts/smoke-shared-avatar-reads.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq, inArray, like, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, linkedinAvatars } from "../src/db/schema";
import { clientAvatarUrlSql, sharedAvatarUrlSql } from "../src/lib/contact-avatar-sql";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const P = "smoke-shared-reads-";
const SHARED = "https://media.licdn.com/dms/image/shared";
const OWN = "https://example.com/own.jpg";

run(async () => {
  const db = await getDb();
  const users = [`${P}u1`, `${P}u2`];
  const cleanup = async () => {
    await db.delete(contacts).where(inArray(contacts.userId, users));
    await db.delete(linkedinAvatars).where(like(linkedinAvatars.slug, `${P}%`));
  };
  await cleanup();

  const ok = `${P}ok`;
  await db.insert(linkedinAvatars).values([
    { slug: ok, imageUrl: SHARED, source: "extension" },
    { slug: `${P}blocked`, imageUrl: SHARED, source: "extension", blockedAt: new Date(), blockedBy: "admin" },
    { slug: `${P}neg`, imageUrl: null, source: "unavatar" },
  ]);
  const mk = async (userId: string, name: string, linkedinUrl: string | null, extra: Partial<typeof contacts.$inferInsert> = {}) =>
    (await db.insert(contacts).values({ userId, fullName: name, linkedinUrl, profileImageUrl: OWN, ...extra }).returning())[0];

  const a1 = await mk(users[0], "A1", `https://www.linkedin.com/in/${ok}/`);
  const a2 = await mk(users[1], "A2", `linkedin.com/in/${ok}?x=1`, { profileImageUrl: null });
  const blocked = await mk(users[0], "Blocked", `https://www.linkedin.com/in/${P}blocked`);
  const neg = await mk(users[0], "Negative", `https://www.linkedin.com/in/${P}neg`);
  const upload = await mk(users[0], "Upload", `https://www.linkedin.com/in/${ok}`, { profileImageSource: "upload" });
  const noSlug = await mk(users[0], "NoSlug", null);
  const noSlugOwn = await mk(users[1], "NoSlug2", "https://www.linkedin.com/company/acme");
  // /in/ on a non-LinkedIn host must never pick up the shared photo.
  const fakeHost = await mk(users[0], "FakeHost", `https://evil.example.com/in/${ok}`);
  const lookalike = await mk(users[0], "Lookalike", `https://notlinkedin.com/in/${ok}`);
  const ids = [a1, a2, blocked, neg, upload, noSlug, noSlugOwn, fakeHost, lookalike].map((c) => c.id);

  console.log("Plain select (clientAvatarUrlSql)...");
  const rows = await db.select({ id: contacts.id, url: clientAvatarUrlSql }).from(contacts).where(inArray(contacts.id, ids));
  const url = (id: string) => rows.find((r) => r.id === id)?.url;
  check("user 1: shared photo wins over own", url(a1.id) === SHARED, String(url(a1.id)));
  check("user 2, same slug, no own photo: same shared photo", url(a2.id) === SHARED, String(url(a2.id)));
  check("blocked row -> own photo", url(blocked.id) === OWN);
  check("negative row -> own photo", url(neg.id) === OWN);
  check("upload source beats shared", url(upload.id) === OWN);
  check("no slug unaffected", url(noSlug.id) === OWN);
  check("linkedin url without /in/ unaffected", url(noSlugOwn.id) === OWN);
  check("non-linkedin host with /in/ unaffected", url(fakeHost.id) === OWN);
  check("lookalike host unaffected", url(lookalike.id) === OWN);

  console.log("\nRelational extras...");
  const rel = await db.query.contacts.findMany({
    where: inArray(contacts.id, ids),
    columns: { id: true },
    extras: { avatarUrl: clientAvatarUrlSql.as("avatar_url"), sharedUrl: sharedAvatarUrlSql.as("shared_url") },
  });
  const relBy = new Map(rel.map((r) => [r.id, r]));
  check("extras: shared wins", relBy.get(a1.id)?.avatarUrl === SHARED && relBy.get(a1.id)?.sharedUrl === SHARED);
  check("extras: blocked/upload/fake host have no shared url", [blocked, upload, fakeHost].every((c) => relBy.get(c.id)?.sharedUrl == null));
  check("extras: upload keeps own", relBy.get(upload.id)?.avatarUrl === OWN);

  console.log("\nRaw SQL...");
  const raw = await db.execute(sql`SELECT ${clientAvatarUrlSql} AS u FROM contacts WHERE contacts.id = ${a2.id}::uuid`);
  const rawRows = (Array.isArray(raw) ? raw : (raw as { rows: unknown[] }).rows) as { u: string }[];
  check("raw: shared wins", rawRows[0]?.u === SHARED);

  console.log("\nContact rows stay free of shared URLs...");
  const stored = await db.select({ id: contacts.id, p: contacts.profileImageUrl }).from(contacts).where(eq(contacts.id, a1.id));
  check("stored profile_image_url untouched", stored[0]?.p === OWN);

  await cleanup();
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll shared-avatar read checks passed.");
});
