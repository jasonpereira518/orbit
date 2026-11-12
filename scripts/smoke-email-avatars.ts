/**
 * The email photo pool (`email_avatars`): the key is a stable hash (JS == SQL, never the raw
 * address); only Gravatar lookups land in it, never a Google/Outlook mailbox photo; reads
 * rank upload > LinkedIn pool > email pool > own photo; the hourly fill pools the most-shared
 * addresses; the orphan sweep drops rows no contact has (blocked rows survive); an admin
 * block clears Gravatar copies and keeps mailbox ones. Network and Blob are stubbed.
 * Run: npx tsx scripts/smoke-email-avatars.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { createHash } from "node:crypto";
import { eq, inArray, like, sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { contacts, emailAvatars, linkedinAvatars } from "../src/db/schema";
import { blockSharedEmailAvatar, unblockSharedEmailAvatar } from "../src/lib/admin-avatars";
import { runAvatarBackfillBatch } from "../src/lib/avatar-backfill";
import { setAvatarBlobClientForTests } from "../src/lib/avatar-blob";
import { clientAvatarUrlSql, emailAvatarKeySql, sharedAvatarUrlSql } from "../src/lib/contact-avatar-sql";
import { fillSharedAvatars, sweepOrphanedSharedAvatars } from "../src/lib/shared-avatar-upkeep";
import {
  getSharedEmailAvatar,
  resolveGravatarCached,
  type ProfileImageSource,
  sharedEmailKey,
  upsertSharedEmailAvatar,
} from "../src/lib/shared-avatars";

process.env.BLOB_READ_WRITE_TOKEN = "smoke-email-avatars";
delete process.env.MICROLINK_API_KEY;
delete process.env.VERCEL;

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const P = "smoke-ea-";
const USERS = [`${P}user-a`, `${P}user-b`];
const ADMIN = `${P}admin`;
const PIXEL =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";
const BLOB = "https://abc.public.blob.vercel-storage.com";
const GOOGLE_PHOTO = "https://lh3.googleusercontent.com/a/smoke-ea";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const mail = (name: string) => `${P}${name}@example.test`;

// ---- stubs: Gravatar has a photo for every hash in `gravatarHas`, 404 otherwise ----------------
const gravatarHas = new Set<string>();
const gravatarAsked: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.includes("gravatar.com/avatar/")) {
    const hash = url.split("/avatar/")[1].split("?")[0];
    gravatarAsked.push(hash);
    return gravatarHas.has(hash)
      ? new Response(Buffer.from(PIXEL, "base64"), { headers: { "content-type": "image/jpeg" } })
      : new Response("not found", { status: 404 });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const puts: string[] = [];
const dels: string[] = [];
setAvatarBlobClientForTests({
  put: async (pathname) => {
    puts.push(pathname);
    return { url: `${BLOB}/${pathname.replace(/\.jpg$/, "")}-R${puts.length}.jpg` };
  },
  del: async (urls) => void dels.push(...urls),
});

run(async () => {
  const db = await getDb();
  const cleanup = async () => {
    const mine = await db.select({ email: contacts.email }).from(contacts).where(inArray(contacts.userId, USERS));
    const keys = mine.map((c) => sharedEmailKey(c.email)).filter((k): k is string => k !== null);
    if (keys.length) await db.delete(emailAvatars).where(inArray(emailAvatars.emailHash, keys));
    await db.delete(linkedinAvatars).where(like(linkedinAvatars.slug, `${P}%`));
    await db.delete(contacts).where(inArray(contacts.userId, USERS));
  };
  await cleanup();
  const row = (key: string) => getSharedEmailAvatar(key);
  const add = async (userId: string, email: string | null, extra: Partial<typeof contacts.$inferInsert> = {}) =>
    (await db.insert(contacts).values({ userId, fullName: `${P}${email ?? "none"}`, email, ...extra }).returning())[0];

  try {
    console.log("The key");
    const k = sharedEmailKey(" Jane.Doe@Example.TEST ");
    check("is sha256 of the lowercased, trimmed address", k === sha("jane.doe@example.test"), String(k));
    check("is stable across case and whitespace", k === sharedEmailKey("jane.doe@example.test") && k === sharedEmailKey("JANE.DOE@EXAMPLE.TEST"));
    check("is 64 hex, never the address", /^[0-9a-f]{64}$/.test(k ?? "") && !k?.includes("@"));
    check("refuses non-addresses and non-ASCII addresses", [null, undefined, "", "  ", "nobody", "jöhn@example.test"].every((e) => sharedEmailKey(e) === null));
    const kc = await add(USERS[0], "  Mixed.Case@Example.TEST ");
    const [sqlKey] = rowsOf<{ k: string }>(await db.execute(sql`SELECT ${emailAvatarKeySql} AS k FROM contacts WHERE contacts.id = ${kc.id}::uuid`));
    check("JS key == SQL key", sqlKey?.k === sharedEmailKey(kc.email), `${sqlKey?.k} vs ${sharedEmailKey(kc.email)}`);
    check("a raw address is refused as a key", (await upsertSharedEmailAvatar({ emailHash: "jane.doe@example.test", imageUrl: null })) === false);
    check("a non-https image is refused", (await upsertSharedEmailAvatar({ emailHash: k!, imageUrl: "http://x.test/p.jpg" })) === false);

    console.log("\nMailbox photos never reach the pool");
    const mailboxEmail = mail("mailbox");
    const mailboxKey = sharedEmailKey(mailboxEmail)!;
    gravatarHas.add(mailboxKey); // Gravatar would have one too: the mailbox photo must still win and stay private
    const mb = await add(USERS[0], mailboxEmail);
    const saved: Array<{ id: string; url: string; source?: string }> = [];
    gravatarAsked.length = 0;
    const res = await runAvatarBackfillBatch([{ id: mb.id, linkedinUrl: null, email: mailboxEmail, remoteUrl: null }], {
      deadline: Date.now() + 60_000,
      persistRemote: async () => null,
      resolveConnectedAccount: async () => ({ url: GOOGLE_PHOTO, source: "google" }),
      resolveLinkedIn: async () => null,
      resolveGravatar: resolveGravatarCached,
      save: async (id, url, source) => void saved.push({ id, url, source }),
      markChecked: async () => {},
    });
    check("the Google photo is saved on the contact", res.saved === 1 && saved[0]?.url === GOOGLE_PHOTO && saved[0]?.source === "google", JSON.stringify(saved));
    check("…Gravatar is never asked", gravatarAsked.length === 0);
    check("…and nothing lands in email_avatars", (await row(mailboxKey)) === null);
    const anyMailbox = await db.select().from(emailAvatars).where(sql`${emailAvatars.imageUrl} LIKE ${"%googleusercontent%"} OR ${emailAvatars.imageUrl} LIKE ${"%graph.microsoft%"}`);
    check("…nor anywhere in the pool", anyMailbox.length === 0);

    console.log("\nGravatar hits are pooled, not saved on the contact");
    const pubEmail = mail("public");
    const pubKey = sharedEmailKey(pubEmail)!;
    gravatarHas.add(pubKey);
    const pa = await add(USERS[0], pubEmail);
    const pb = await add(USERS[1], pubEmail.toUpperCase());
    saved.length = 0;
    const marked: string[] = [];
    const deps = {
      deadline: Date.now() + 60_000,
      persistRemote: async () => null,
      resolveLinkedIn: async () => null,
      resolveGravatar: resolveGravatarCached,
      save: async (id: string, url: string, source?: ProfileImageSource) => void saved.push({ id, url, source }),
      markChecked: async (id: string) => void marked.push(id),
    };
    gravatarAsked.length = 0;
    const r1 = await runAvatarBackfillBatch([{ id: pa.id, linkedinUrl: null, email: pubEmail, remoteUrl: null }], deps);
    const pooled = await row(pubKey);
    check("a hit writes one pool row with source gravatar", pooled?.source === "gravatar" && pooled.imageUrl?.startsWith(`${BLOB}/avatars-shared/`) === true, JSON.stringify(pooled));
    check("…counts as saved without writing onto the contact", r1.saved === 1 && saved.length === 0 && marked.includes(pa.id));
    const r2 = await runAvatarBackfillBatch([{ id: pb.id, linkedinUrl: null, email: pb.email, remoteUrl: null }], deps);
    check("a second account with that address reads the cache (one Gravatar call total)", r2.saved === 1 && gravatarAsked.length === 1, String(gravatarAsked.length));
    const missEmail = mail("miss");
    const mc = await add(USERS[0], missEmail);
    await runAvatarBackfillBatch([{ id: mc.id, linkedinUrl: null, email: missEmail, remoteUrl: null }], deps);
    const miss = await row(sharedEmailKey(missEmail)!);
    check("a miss is remembered as a negative row", miss !== null && miss.imageUrl === null);

    console.log("\nRead precedence");
    const LI = `${BLOB}/avatars-shared/li-R0.jpg`;
    const OWN = "https://example.test/own.jpg";
    const slug = `${P}both`;
    await db.insert(linkedinAvatars).values({ slug, imageUrl: LI, source: "unavatar" });
    const both = await add(USERS[0], pubEmail, { linkedinUrl: `https://www.linkedin.com/in/${slug}`, profileImageUrl: OWN, profileImageSource: "google" });
    const emailOnly = await add(USERS[0], pubEmail, { profileImageUrl: OWN, profileImageSource: "google" });
    const upload = await add(USERS[0], pubEmail, { profileImageUrl: OWN, profileImageSource: "upload" });
    const negOnly = await add(USERS[0], missEmail, { profileImageUrl: OWN });
    const noEmail = await add(USERS[0], null, { profileImageUrl: OWN });
    const reads = await db
      .select({ id: contacts.id, url: clientAvatarUrlSql, shared: sharedAvatarUrlSql })
      .from(contacts)
      .where(inArray(contacts.id, [both.id, emailOnly.id, upload.id, negOnly.id, noEmail.id, pb.id]));
    const url = (id: string) => reads.find((r) => r.id === id)?.url;
    check("LinkedIn pool beats the email pool", url(both.id) === LI, String(url(both.id)));
    check("email pool beats the contact's own (mailbox) photo", url(emailOnly.id) === pooled?.imageUrl, String(url(emailOnly.id)));
    check("an upload beats both pools", url(upload.id) === OWN);
    check("a negative row falls back to the own photo", url(negOnly.id) === OWN);
    check("no email: own photo", url(noEmail.id) === OWN);
    check("matching ignores case (the other account sees it too)", url(pb.id) === pooled?.imageUrl);

    console.log("\nHourly fill");
    const fillEmail = mail("fill");
    const fillKey = sharedEmailKey(fillEmail)!;
    gravatarHas.add(fillKey);
    await add(USERS[0], fillEmail);
    await add(USERS[1], fillEmail);
    // Other smokes' contacts may also lack rows; a big limit lets the run reach ours.
    await fillSharedAvatars(500);
    check("the fill pools an address that has no row yet", (await row(fillKey))?.imageUrl?.startsWith(BLOB) === true);

    console.log("\nOrphan sweep");
    const orphanKey = sha(`${P}orphan@example.test`);
    const blockedOrphanKey = sha(`${P}blocked-orphan@example.test`);
    await upsertSharedEmailAvatar({ emailHash: orphanKey, imageUrl: `${BLOB}/avatars-shared/orphan-R0.jpg` });
    await db.insert(emailAvatars).values({ emailHash: blockedOrphanKey, source: "gravatar", blockedAt: new Date(), blockedBy: ADMIN });
    dels.length = 0;
    await sweepOrphanedSharedAvatars();
    check("a row no contact has is removed, with its object", (await row(orphanKey)) === null && dels.includes(`${BLOB}/avatars-shared/orphan-R0.jpg`));
    check("a blocked orphan survives", (await row(blockedOrphanKey))?.blockedAt != null);
    check("a row a contact still has is kept", (await row(pubKey))?.imageUrl === pooled?.imageUrl);
    await db.delete(emailAvatars).where(eq(emailAvatars.emailHash, blockedOrphanKey));

    console.log("\nAdmin block");
    const gravCopy = await add(USERS[1], pubEmail, { profileImageUrl: `${BLOB}/avatars/grav-copy.jpg`, profileImageSource: "gravatar" });
    dels.length = 0;
    await blockSharedEmailAvatar(ADMIN, { email: ` ${pubEmail.toUpperCase()} `, reason: "takedown request" });
    const blocked = await row(pubKey);
    check("block clears the image and records who", blocked?.imageUrl === null && blocked.blockedBy === ADMIN && blocked.blockedAt !== null);
    check("…and deletes the pooled object", dels.includes(pooled!.imageUrl!));
    const after = await db.select().from(contacts).where(inArray(contacts.id, [gravCopy.id, emailOnly.id]));
    const of = (id: string) => after.find((c) => c.id === id);
    check("a per-contact Gravatar copy is removed", of(gravCopy.id)?.profileImageUrl === null && dels.includes(`${BLOB}/avatars/grav-copy.jpg`));
    check("a mailbox photo is kept", of(emailOnly.id)?.profileImageUrl === OWN && of(emailOnly.id)?.profileImageSource === "google");
    gravatarAsked.length = 0;
    check("a blocked address is never fetched", (await resolveGravatarCached(pa.id, pubEmail)) === null && gravatarAsked.length === 0);
    await unblockSharedEmailAvatar(ADMIN, { email: pubKey, reason: "request withdrawn" });
    check("unblock (by hash) removes the row", (await row(pubKey)) === null);
  } finally {
    await cleanup();
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll email avatar checks passed.");
  process.exit(0);
});
