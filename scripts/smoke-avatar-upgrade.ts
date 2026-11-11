/**
 * The soft-photo upgrade pass (`src/lib/avatar-upgrade.ts`): a small inline LinkedIn photo is
 * swapped for a bigger one, and only for a bigger one.
 *
 * `fetch` is stubbed, so no LinkedIn / Unavatar / Microlink request leaves the machine; the
 * real tier ladder, encoder and quota buckets run against a throwaway PGlite. Each guard has
 * a case that goes red when the guard is removed.
 *
 * Run: npx tsx scripts/smoke-avatar-upgrade.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq, like } from "drizzle-orm";
import sharp from "sharp";
import { getDb } from "../src/db";
import { contacts, linkedinAvatars, rateLimitBuckets } from "../src/db/schema";
import { setAvatarBlobClientForTests } from "../src/lib/avatar-blob";
import {
  AVATAR_UPGRADE_COOLDOWN_DAYS,
  SOFT_AVATAR_PX,
  judgeUpgrade,
  measureInlineJpeg,
  minEdge,
  runAvatarUpgradePass,
} from "../src/lib/avatar-upgrade";
import { jpegDimensions } from "../src/lib/jpeg-dimensions";
import { TOUR_EXAMPLE_SOURCE } from "../src/lib/onboarding-examples/marker";
import { RATE_LIMITS, consumeBucket } from "../src/lib/rate-limit";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** A real JPEG of the given size. */
async function jpeg(width: number, height = width, opts: { progressive?: boolean; grey?: boolean } = {}) {
  // A smooth gradient with a little grain: file sizes in the range of real avatars.
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) {
    const px = (i / 3) | 0;
    raw[i] = ((px % width) + ((px / width) | 0) + (i % 3) * 60 + ((i * 2654435761) >>> 29)) & 0xff;
  }
  let img = sharp(raw, { raw: { width, height, channels: 3 } });
  if (opts.grey) img = img.greyscale();
  return img.jpeg({ quality: 85, progressive: opts.progressive }).toBuffer();
}

const dataUrl = (buf: Buffer, type = "image/jpeg") => `data:${type};base64,${buf.toString("base64")}`;
const edgeOf = (url: string | null) => {
  const dim = url ? measureInlineJpeg(url.slice(0, 8192)) : null;
  return dim ? minEdge(dim) : null;
};

// ---- What the stubbed world serves, per LinkedIn slug --------------------------------------
type World = {
  /** The direct profile page's og:image photo, or null for a 404 (falls through to Unavatar). */
  photo?: Buffer | null;
  unavatar?: "svg" | "429";
  microlink?: "fail" | "429";
};
const world = new Map<string, World>();
const calls: string[] = [];
const slugCalls = (slug: string) => calls.filter((u) => u.includes(slug)).length;

function installFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const media = /media\.licdn\.com\/dms\/image\/v2\/([^/]+)\//.exec(url);
    if (media) {
      const photo = world.get(media[1])?.photo;
      return photo
        ? new Response(new Uint8Array(photo), { status: 200, headers: { "Content-Type": "image/jpeg" } })
        : new Response(null, { status: 404 });
    }
    const page = /^https:\/\/www\.linkedin\.com\/in\/([^/?]+)/.exec(url);
    if (page) {
      const w = world.get(decodeURIComponent(page[1]));
      if (!w?.photo) return new Response(null, { status: 404 });
      const og = `https://media.licdn.com/dms/image/v2/${page[1]}/profile-displayphoto-shrink_100_100/0/1?e=1`;
      return new Response(`<html><head><meta property="og:image" content="${og}"></head></html>`, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }
    const unavatar = /^https:\/\/unavatar\.io\/linkedin\/([^/?]+)/.exec(url);
    if (unavatar) {
      const w = world.get(decodeURIComponent(unavatar[1]));
      if (w?.unavatar === "429") return new Response("slow down", { status: 429, headers: { "retry-after": "3600" } });
      // What Unavatar really answers for a miss: HTTP 200 and a generated silhouette.
      return new Response('<svg xmlns="http://www.w3.org/2000/svg" id="person-accent-4" width="300" height="300" viewBox="0 0 300 300"><path d="M0 0h300v300H0z"/></svg>', {
        status: 200,
        headers: { "Content-Type": "image/svg+xml" },
      });
    }
    if (url.startsWith("https://api.microlink.io/")) {
      const slug = /in%2F([^&%]+)/.exec(url)?.[1] ?? "";
      if (world.get(slug)?.microlink === "429") return new Response("{}", { status: 429, headers: { "retry-after": "3600" } });
      return Response.json({ status: "fail", message: "not found" });
    }
    return new Response(null, { status: 500 });
  }) as typeof fetch;
}

async function addContact(
  db: Awaited<ReturnType<typeof getDb>>,
  user: string,
  slug: string,
  photo: string | null,
  over: Partial<typeof contacts.$inferInsert> = {}
) {
  const [row] = await db
    .insert(contacts)
    .values({
      userId: user,
      fullName: `Upgrade ${slug}`,
      linkedinUrl: `https://www.linkedin.com/in/${slug}`,
      profileImageUrl: photo,
      profileImageSource: "public",
      ...over,
    })
    .returning();
  return row.id;
}

async function row(db: Awaited<ReturnType<typeof getDb>>, id: string) {
  const [r] = await db.select().from(contacts).where(eq(contacts.id, id));
  return r;
}

run(async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_STORE_ID;
  delete process.env.VERCEL;
  delete process.env.MICROLINK_API_KEY;
  const realFetch = globalThis.fetch;
  installFetch();

  // ---- jpegDimensions on real JPEGs ---------------------------------------------------------
  console.log("jpegDimensions reads the SOF marker of real JPEGs…");
  for (const [w, h] of [[1, 1], [16, 16], [64, 64], [100, 100], [199, 199], [200, 200], [384, 384], [150, 300], [640, 360], [1000, 600]]) {
    const buf = await jpeg(w, h);
    const d = jpegDimensions(buf);
    check(`baseline ${w}x${h}`, d?.width === w && d?.height === h, JSON.stringify(d));
  }
  {
    const d = jpegDimensions(await jpeg(321, 123, { progressive: true }));
    check("progressive (SOF2) 321x123", d?.width === 321 && d?.height === 123, JSON.stringify(d));
    const g = jpegDimensions(await jpeg(90, 70, { grey: true }));
    check("greyscale 90x70", g?.width === 90 && g?.height === 70, JSON.stringify(g));
    const withIcc = await sharp(await jpeg(256)).withIccProfile("srgb").jpeg().toBuffer();
    const icc = jpegDimensions(withIcc);
    check("a large ICC profile segment before the frame header is skipped", icc?.width === 256 && withIcc.length > 1000, JSON.stringify(icc));
    const full = await jpeg(500);
    const d600 = jpegDimensions(full.subarray(0, 600));
    check("a 600-byte prefix of a 500px JPEG is enough", d600?.width === 500 && d600?.height === 500, JSON.stringify(d600));
    check("a prefix cut before the frame header says null", jpegDimensions(full.subarray(0, 8)) === null);
    check("an empty buffer says null", jpegDimensions(Buffer.alloc(0)) === null);
    check("a PNG says null", jpegDimensions(await sharp(await jpeg(50)).png().toBuffer()) === null);
    check("garbage after SOI says null", jpegDimensions(Buffer.from([0xff, 0xd8, 0x12, 0x34, 0x56, 0x78])) === null);
    check("SOI then EOI says null", jpegDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xd9])) === null);
    check(
      "measureInlineJpeg reads a data URL prefix and refuses a non-JPEG data URL",
      edgeOf(dataUrl(full).slice(0, 8192)) === 500 && measureInlineJpeg(dataUrl(full, "image/png")) === null
    );
  }

  // ---- judgeUpgrade ---------------------------------------------------------------------------
  console.log("judgeUpgrade: strictly larger and cleanly decoded, or no swap…");
  {
    const big = await jpeg(400);
    const truncated = big.subarray(0, Math.floor(big.length * 0.6));
    check("a bigger complete JPEG is better", judgeUpgrade(100, dataUrl(big)) === "better");
    check("an equal-size JPEG is NOT better", judgeUpgrade(400, dataUrl(big)) === "not_bigger");
    check("a smaller JPEG is not better", judgeUpgrade(500, dataUrl(big)) === "not_bigger");
    check("a bigger but CUT-OFF JPEG is refused", judgeUpgrade(100, dataUrl(truncated)) === "unreadable");
    check("nothing is refused", judgeUpgrade(100, null) === "unreadable");
    check("a PNG is refused (cannot be measured)", judgeUpgrade(100, dataUrl(await sharp(big).png().toBuffer(), "image/png")) === "unreadable");
    check("a remote URL is refused", judgeUpgrade(100, "https://media.licdn.com/x.jpg") === "unreadable");
  }

  const db = await getDb();
  // The runner shares one PGlite across scripts: start from full quota, and leave it that way.
  const resetQuota = () => db.delete(rateLimitBuckets).where(like(rateLimitBuckets.bucket, "avatarSource.%"));
  const cleanUp = async () => {
    await db.delete(contacts).where(like(contacts.userId, "upgrade-user-%"));
    await db.delete(linkedinAvatars).where(eq(linkedinAvatars.slug, "p-pool"));
    await resetQuota();
  };
  await cleanUp();
  const soft100 = dataUrl(await jpeg(100));
  const soft64 = dataUrl(await jpeg(64));
  const fine384 = dataUrl(await jpeg(384));

  // ---- A soft photo is replaced by a bigger one ---------------------------------------------
  console.log("A soft photo is replaced by a bigger one…");
  {
    const U = "upgrade-user-replace";
    world.set("up-pub", { photo: await jpeg(500) });
    world.set("up-ext", { photo: await jpeg(500) });
    world.set("up-nul", { photo: await jpeg(500) });
    const pub = await addContact(db, U, "up-pub", soft100, { profileImageSource: "public" });
    const ext = await addContact(db, U, "up-ext", soft100, { profileImageSource: "extension" });
    const nul = await addContact(db, U, "up-nul", soft100, { profileImageSource: null });
    const before = await row(db, pub);
    const r = await runAvatarUpgradePass(db, U, { batchSize: 10 });
    check("three soft photos were upgraded", r.upgraded === 3 && r.stopped === null, JSON.stringify(r));
    for (const [label, id] of [["public", pub], ["extension", ext], ["unknown-source", nul]] as const) {
      const c = await row(db, id);
      check(`${label}: stored photo is now bigger than ${SOFT_AVATAR_PX}px`, (edgeOf(c.profileImageUrl) ?? 0) >= SOFT_AVATAR_PX, String(edgeOf(c.profileImageUrl)));
      check(`${label}: source is now 'public' and the clock is stamped`, c.profileImageSource === "public" && c.profileImageCheckedAt !== null);
    }
    const after = await row(db, pub);
    check("updated_at is left alone (a photo swap is not an edit)", after.updatedAt?.getTime() === before.updatedAt?.getTime());
    check("the swapped photo is an inline JPEG", Boolean(after.profileImageUrl?.startsWith("data:image/jpeg;base64,")));
  }

  // ---- A not-bigger result leaves the photo untouched ----------------------------------------
  console.log("A result that is not bigger leaves the stored photo untouched…");
  {
    const U = "upgrade-user-notbigger";
    world.set("up-small", { photo: await jpeg(80) }); // smaller than the stored 100
    world.set("up-equal", { photo: await jpeg(100) }); // same as the stored 100
    const small = await addContact(db, U, "up-small", soft100);
    const equal = await addContact(db, U, "up-equal", soft100);
    const r = await runAvatarUpgradePass(db, U, { batchSize: 10 });
    check("both were looked up, neither upgraded", r.attempted === 2 && r.upgraded === 0, JSON.stringify(r));
    for (const [label, id] of [["smaller", small], ["equal-size", equal]] as const) {
      const c = await row(db, id);
      check(`${label}: stored photo is byte-for-byte what it was`, c.profileImageUrl === soft100);
      check(`${label}: attempt recorded (cooldown started)`, c.profileImageCheckedAt !== null);
    }
  }

  // ---- Cooldown ---------------------------------------------------------------------------------
  console.log("The cooldown prevents a retry…");
  {
    const U = "upgrade-user-notbigger";
    const before = slugCalls("up-small");
    const r = await runAvatarUpgradePass(db, U, { batchSize: 10 });
    check("a second pass looks at nothing", r.examined === 0 && r.attempted === 0, JSON.stringify(r));
    check("and made no request for that contact", slugCalls("up-small") === before);

    const [c] = await db.select().from(contacts).where(eq(contacts.fullName, "Upgrade up-small"));
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
    await db.update(contacts).set({ profileImageCheckedAt: ago(AVATAR_UPGRADE_COOLDOWN_DAYS - 1) }).where(eq(contacts.id, c.id));
    const inside = await runAvatarUpgradePass(db, U, { batchSize: 10 });
    check(`${AVATAR_UPGRADE_COOLDOWN_DAYS - 1} days later it is still on cooldown`, inside.attempted === 0);
    await db.update(contacts).set({ profileImageCheckedAt: ago(AVATAR_UPGRADE_COOLDOWN_DAYS + 1) }).where(eq(contacts.id, c.id));
    const outside = await runAvatarUpgradePass(db, U, { batchSize: 10 });
    check(`${AVATAR_UPGRADE_COOLDOWN_DAYS + 1} days later it is looked at again`, outside.attempted === 1, JSON.stringify(outside));
  }

  // ---- Protected sources, tour examples, ineligible values -------------------------------------
  console.log("Photos this pass must never touch…");
  {
    const U = "upgrade-user-protected";
    for (const slug of ["p-upload", "p-google", "p-outlook", "p-gravatar", "p-apollo", "p-tour", "p-pool", "p-blobhost", "p-png", "p-nolinkedin"]) {
      world.set(slug, { photo: await jpeg(500) });
    }
    const png = dataUrl(await sharp(await jpeg(100)).png().toBuffer(), "image/png");
    const blobUrl = "https://abc.public.blob.vercel-storage.com/avatars/x.jpg";
    const ids = {
      upload: await addContact(db, U, "p-upload", soft100, { profileImageSource: "upload" }),
      google: await addContact(db, U, "p-google", soft100, { profileImageSource: "google" }),
      outlook: await addContact(db, U, "p-outlook", soft100, { profileImageSource: "outlook" }),
      gravatar: await addContact(db, U, "p-gravatar", soft100, { profileImageSource: "gravatar" }),
      apollo: await addContact(db, U, "p-apollo", soft100, { profileImageSource: "apollo" }),
      tour: await addContact(db, U, "p-tour", soft100, { source: TOUR_EXAMPLE_SOURCE }),
      pool: await addContact(db, U, "p-pool", soft100),
      blob: await addContact(db, U, "p-blobhost", blobUrl),
      png: await addContact(db, U, "p-png", png),
      noLinkedIn: await addContact(db, U, "p-nolinkedin", soft100, { linkedinUrl: null }),
    };
    // The shared pool shows ahead of the contact's own copy: upgrading that copy changes nothing.
    await db.insert(linkedinAvatars).values({ slug: "p-pool", imageUrl: "https://media.licdn.com/x/profile-displayphoto/1", source: "unavatar" });
    const stored: Record<string, string | null> = {};
    for (const [k, id] of Object.entries(ids)) stored[k] = (await row(db, id)).profileImageUrl;

    const r = await runAvatarUpgradePass(db, U, { batchSize: 10 });
    check("nothing was even examined", r.examined === 0 && r.attempted === 0 && r.upgraded === 0, JSON.stringify(r));
    for (const [k, id] of Object.entries(ids)) {
      const c = await row(db, id);
      check(`${k}: photo untouched and never stamped`, c.profileImageUrl === stored[k] && c.profileImageCheckedAt === null);
    }
    check("no lookup was made for any of them", calls.filter((u) => /p-(upload|google|outlook|gravatar|apollo|tour|pool|blobhost|png|nolinkedin)/.test(u)).length === 0);
  }

  // ---- A photo that is already fine is read once, never looked up ------------------------------
  console.log("A photo at or above the threshold is not looked up…");
  {
    const U = "upgrade-user-fine";
    world.set("f-fine", { photo: await jpeg(500) });
    world.set("f-edge", { photo: await jpeg(500) });
    const fine = await addContact(db, U, "f-fine", fine384);
    const edge = await addContact(db, U, "f-edge", dataUrl(await jpeg(SOFT_AVATAR_PX)));
    const r = await runAvatarUpgradePass(db, U, { batchSize: 10 });
    check("two photos read, none soft, none looked up", r.examined === 2 && r.soft === 0 && r.attempted === 0, JSON.stringify(r));
    check(`exactly ${SOFT_AVATAR_PX}px counts as fine`, (await row(db, edge)).profileImageUrl !== null && slugCalls("f-edge") === 0);
    check("they are stamped, so they are not read again for 90 days", (await row(db, fine)).profileImageCheckedAt !== null);
    const again = await runAvatarUpgradePass(db, U, { batchSize: 10 });
    check("a second pass reads nothing", again.examined === 0);
  }

  // ---- A placeholder SVG never replaces a working photo ----------------------------------------
  console.log("A placeholder silhouette never replaces a working photo…");
  {
    const U = "upgrade-user-svg";
    world.set("s-svg", { photo: null }); // page 404 -> Unavatar answers 200 + SVG -> Microlink finds nothing
    const id = await addContact(db, U, "s-svg", soft64);
    const r = await runAvatarUpgradePass(db, U, { batchSize: 10 });
    check("looked up, nothing better", r.attempted === 1 && r.upgraded === 0 && r.stopped === null, JSON.stringify(r));
    check("Unavatar really was asked (and answered the SVG)", calls.some((u) => u.includes("unavatar.io/linkedin/s-svg")));
    check("the working photo is untouched", (await row(db, id)).profileImageUrl === soft64);
  }

  // ---- A cut-off JPEG never replaces a working photo -------------------------------------------
  console.log("A cut-off bigger JPEG never replaces a working photo…");
  {
    const U = "upgrade-user-trunc";
    const big = await jpeg(600);
    const cut = big.subarray(0, Math.floor(big.length * 0.6));
    world.set("t-cut", { photo: cut });
    const id = await addContact(db, U, "t-cut", soft100);
    const r = await runAvatarUpgradePass(db, U, { batchSize: 10 });
    check("through the real ladder: not upgraded", r.upgraded === 0, JSON.stringify(r));
    check("through the real ladder: photo untouched", (await row(db, id)).profileImageUrl === soft100);

    // The pass's own guard, independent of what the encoder happens to do with it.
    const U2 = "upgrade-user-trunc-dep";
    const id2 = await addContact(db, U2, "t-cut-dep", soft100);
    const r2 = await runAvatarUpgradePass(db, U2, { batchSize: 10, fetchPhoto: async () => dataUrl(cut) });
    check("handed a cut-off bigger JPEG directly: not upgraded", r2.upgraded === 0 && r2.attempted === 1, JSON.stringify(r2));
    check("handed a cut-off bigger JPEG directly: photo untouched", (await row(db, id2)).profileImageUrl === soft100);
  }

  // ---- A swap never overwrites a photo that changed during the lookup --------------------------
  console.log("A photo changed while the lookup ran is not overwritten…");
  {
    const U = "upgrade-user-race";
    const bigger = dataUrl(await jpeg(400));
    // Same source, different bytes: another tab saved a photo meanwhile.
    const a = await addContact(db, U, "r-bytes", soft100);
    const replaced = dataUrl(await jpeg(120));
    const r1 = await runAvatarUpgradePass(db, U, {
      batchSize: 1,
      fetchPhoto: async (c) => {
        await db.update(contacts).set({ profileImageUrl: c.id === a ? replaced : soft100 }).where(eq(contacts.id, a));
        return bigger;
      },
    });
    check("new bytes under the same source: swap refused", r1.upgraded === 0 && (await row(db, a)).profileImageUrl === replaced, JSON.stringify(r1));

    // Same bytes, source flipped to upload: the person chose this photo meanwhile.
    const U2 = "upgrade-user-race-src";
    const b = await addContact(db, U2, "r-source", soft100);
    const r2 = await runAvatarUpgradePass(db, U2, {
      batchSize: 1,
      fetchPhoto: async () => {
        await db.update(contacts).set({ profileImageSource: "upload" }).where(eq(contacts.id, b));
        return bigger;
      },
    });
    const cb = await row(db, b);
    check("source flipped to upload: swap refused", r2.upgraded === 0 && cb.profileImageUrl === soft100 && cb.profileImageSource === "upload", JSON.stringify(r2));
  }

  // ---- Quota headroom: the pass stands aside for the primary backfill --------------------------
  console.log("The pass leaves quota for the primary backfill…");
  {
    const U = "upgrade-user-headroom";
    world.set("h-low", { photo: await jpeg(500) });
    const id = await addContact(db, U, "h-low", soft100);
    // Three of the user's five daily Unavatar lookups spent: left 2, and 3 are reserved.
    for (let i = 0; i < 3; i++) await consumeBucket("avatarSource.user", `unavatar:${U}`, RATE_LIMITS.avatarSourceUser);
    const r = await runAvatarUpgradePass(db, U, { batchSize: 10 });
    check("stopped on quota without a single request", r.stopped === "quota" && r.attempted === 0 && slugCalls("h-low") === 0, JSON.stringify(r));
    check("and did not stamp the contact", (await row(db, id)).profileImageCheckedAt === null);
  }

  // ---- Blob configured: stands down ---------------------------------------------------------------
  console.log("With a Blob store configured the pass stands down…");
  {
    process.env.BLOB_READ_WRITE_TOKEN = "test-token";
    setAvatarBlobClientForTests({ put: async () => ({ url: "https://x.public.blob.vercel-storage.com/avatars/n.jpg" }), del: async () => {} });
    const r = await runAvatarUpgradePass(db, "upgrade-user-headroom", { batchSize: 10 });
    check("stopped: blob, nothing examined", r.stopped === "blob" && r.examined === 0, JSON.stringify(r));
    delete process.env.BLOB_READ_WRITE_TOKEN;
    setAvatarBlobClientForTests(null);
  }

  // ---- Rate limiting stops the pass and does not stamp -------------------------------------------
  // Last: a 429 puts Unavatar and Microlink on a process-wide cooldown.
  console.log("Rate limiting stops the pass and does not stamp the contact…");
  {
    const U = "upgrade-user-ratelimit";
    for (const s of ["q-1", "q-2", "q-3"]) world.set(s, { photo: null, unavatar: "429", microlink: "429" });
    const ids = [await addContact(db, U, "q-1", soft100), await addContact(db, U, "q-2", soft100), await addContact(db, U, "q-3", soft100)];
    const r = await runAvatarUpgradePass(db, U, { batchSize: 10 });
    check("stopped on the rate limit", r.stopped === "rate_limit" && r.rateLimitedUntil !== null && r.upgraded === 0, JSON.stringify(r));
    check("after one lookup, not three", r.attempted === 1, String(r.attempted));
    const stamped = await Promise.all(ids.map(async (id) => (await row(db, id)).profileImageCheckedAt));
    check("no contact was stamped as checked", stamped.every((s) => s === null));
    check("the photos are untouched", (await Promise.all(ids.map(async (id) => (await row(db, id)).profileImageUrl))).every((p) => p === soft100));
    // Contacts go in id order (random uuids), so which one was first is not fixed: exactly one was asked.
    const asked = ["q-1", "q-2", "q-3"].filter((slug) => slugCalls(slug) > 0);
    check("the other two were never looked up", asked.length === 1, asked.join(","));
  }

  globalThis.fetch = realFetch;
  await cleanUp();
  console.log(failures === 0 ? "\nAll avatar upgrade checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures) process.exit(1);
});
