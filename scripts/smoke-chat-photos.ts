/**
 * Pins the contact photos the chat's activity scene shows (`src/lib/chat-photos.ts`).
 *
 * The scene shows people's faces while an answer is worked out. Two things have to hold that
 * a screenshot cannot show: the stored photo column — base64 up to 120 KB per contact — must
 * never travel down the chat stream, and a contact with no usable photo must resolve to none
 * rather than to a lookup that spends the metered third-party quota. The photo arrives after
 * the stage that named the contact, and must not re-stamp that stage's duration on the way.
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-chat-photos.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { prepareChatContext } from "../src/lib/chat-context";
import { attachPhotos, createPhotoCache, loadPhotoUrls } from "../src/lib/chat-photos";
import { createStepEmitter } from "../src/lib/chat-steps";
import type { ChatStep } from "../src/lib/chat-stream-protocol";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-chat-photos-user";
const OTHER = "smoke-chat-photos-other";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const db = await getDb();
  await db.delete(contacts).where(inArray(contacts.userId, [USER, OTHER]));
  await ensureUserSettings(USER);

  // A photo big enough that leaking it would be unmistakable.
  const bigPhoto = `data:image/png;base64,${"A".repeat(60_000)}`;
  const [dataPhoto, hosted, placeholder, noPhoto] = await db
    .insert(contacts)
    .values([
      { userId: USER, fullName: "Ada Lovelace", company: "Acme", profileImageUrl: bigPhoto },
      { userId: USER, fullName: "Grace Hopper", company: "Acme", profileImageUrl: "https://abc.public.blob.vercel-storage.com/grace.jpg" },
      { userId: USER, fullName: "Alan Turing", company: "Acme", profileImageUrl: "https://unavatar.io/linkedin/alan" },
      { userId: USER, fullName: "Katherine Johnson", company: "Acme" },
    ])
    .returning();
  const [foreign] = await db
    .insert(contacts)
    .values({ userId: OTHER, fullName: "Someone Else", profileImageUrl: "https://abc.public.blob.vercel-storage.com/x.jpg" })
    .returning();

  console.log("Resolving photos...");
  const cache = createPhotoCache();
  await loadPhotoUrls(USER, [dataPhoto.id, hosted.id, placeholder.id, noPhoto.id, foreign.id], cache);

  check("a data: photo becomes the short same-origin route", cache.get(dataPhoto.id) === `/api/avatars/${dataPhoto.id}`, String(cache.get(dataPhoto.id)));
  check("the photo bytes never appear in what is sent", !JSON.stringify([...cache.values()]).includes("AAAAAAAA"));
  check("a hosted photo is passed through", cache.get(hosted.id)?.startsWith("https://abc.public.blob.vercel-storage.com/") === true);
  check("a placeholder host resolves to none, not a broken image", cache.get(placeholder.id) === null);
  check("a contact with no photo resolves to none", cache.get(noPhoto.id) === null);
  check("another user's contact resolves to none, not their photo", cache.get(foreign.id) === null);
  check("every asked-for id is remembered, found or not", [dataPhoto, hosted, placeholder, noPhoto, foreign].every((c) => cache.has(c.id)));

  console.log("\nThe cache spares a repeat lookup");
  {
    const warm = createPhotoCache();
    warm.set(hosted.id, "cached-sentinel");
    await loadPhotoUrls(USER, [hosted.id], warm);
    check("an id already known is not asked for again", warm.get(hosted.id) === "cached-sentinel");
    await loadPhotoUrls(USER, [], warm);
    check("an empty request is a no-op", warm.size === 1);
  }

  console.log("\nA photo arrives after its stage, without re-stamping it");
  {
    const seen: ChatStep[] = [];
    const steps = createStepEmitter((s) => seen.push({ ...s }));
    steps.start("rank", "Ranking");
    await sleep(40);
    const refs = [
      { id: dataPhoto.id, name: "Ada Lovelace", kind: "contact" as const },
      { id: noPhoto.id, name: "Katherine Johnson", kind: "contact" as const },
    ];
    steps.done("rank", { label: "Kept 2", refs });
    const finished = seen[seen.length - 1];
    const msAtDone = finished?.ms;

    attachPhotos(steps, "rank", refs, USER, createPhotoCache());
    await sleep(400);

    const last = seen[seen.length - 1];
    check("the stage is re-sent once with the photo attached", seen.length === 3 && last?.refs?.[0]?.photoUrl === `/api/avatars/${dataPhoto.id}`, JSON.stringify(last?.refs));
    check("the contact with no photo stays without one", last?.refs?.[1]?.photoUrl === null);
    check("the update leaves the stage done", last?.status === "done");
    check("the update does NOT re-stamp the duration", last?.ms === msAtDone, `${msAtDone} -> ${last?.ms}`);
    check("the label survives the update", last?.label === "Kept 2");
  }

  console.log("\nNothing is re-sent when there is nothing to add");
  {
    const seen: ChatStep[] = [];
    const steps = createStepEmitter((s) => seen.push({ ...s }));
    steps.start("rank", "Ranking");
    const refs = [{ id: noPhoto.id, name: "Katherine Johnson", kind: "contact" as const }];
    steps.done("rank", { label: "Kept 1", refs });
    const before = seen.length;
    attachPhotos(steps, "rank", refs, USER, createPhotoCache());
    await sleep(400);
    check("nobody has a photo, so no redundant update", seen.length === before);

    const orgOnly = createStepEmitter((s) => seen.push({ ...s }));
    orgOnly.start("roster", "Roster");
    orgOnly.done("roster", { label: "At Acme", refs: [{ id: "Acme", name: "Acme", kind: "org" }] });
    const n = seen.length;
    attachPhotos(orgOnly, "roster", [{ id: "Acme", name: "Acme", kind: "org" }], USER, createPhotoCache());
    await sleep(200);
    check("an organisation ref is never looked up as a contact", seen.length === n);
  }

  console.log("\nA lookup that fails is swallowed, not surfaced");
  {
    const seen: ChatStep[] = [];
    const steps = createStepEmitter((s) => seen.push({ ...s }));
    steps.start("rank", "Ranking");
    steps.done("rank", { label: "Kept 1" });
    let threw = false;
    process.once("unhandledRejection", () => {
      threw = true;
    });
    // Not a UUID: the query errors, which must not become an unhandled rejection.
    attachPhotos(steps, "rank", [{ id: "not-a-uuid", name: "Nobody", kind: "contact" }], USER, createPhotoCache());
    await sleep(400);
    check("a failing lookup raises no unhandled rejection", !threw);
    check("and adds no update", seen.length === 2);
  }

  console.log("\nThe real pipeline reports candidates early and photos later");
  {
    const seen: ChatStep[] = [];
    const steps = createStepEmitter((s) => seen.push({ ...s }));
    await prepareChatContext(USER, "Who do I know at Acme?", { steps });
    await sleep(500);

    const searchDone = seen.find((s) => s.kind === "search" && s.status === "done");
    check("the search step names its top candidates", (searchDone?.refs?.length ?? 0) > 0, JSON.stringify(searchDone));
    check("candidates are contacts", searchDone?.refs?.every((r) => r.kind === "contact") === true);

    const searchUpdates = seen.filter((s) => s.kind === "search" && s.status === "done");
    const withPhoto = searchUpdates.at(-1)?.refs?.find((r) => r.id === dataPhoto.id);
    check("a candidate's photo is patched on afterwards", withPhoto?.photoUrl === `/api/avatars/${dataPhoto.id}`, JSON.stringify(withPhoto));

    const wire = JSON.stringify(seen);
    check("no photo bytes anywhere in the whole step stream", !wire.includes("AAAAAAAA") && !wire.includes("data:image"));

    const rankDone = seen.filter((s) => s.kind === "rank" && s.status === "done");
    const firstRankMs = rankDone[0]?.ms;
    check("a later photo update keeps the rank duration", rankDone.every((s) => s.ms === firstRankMs), JSON.stringify(rankDone.map((s) => s.ms)));
  }

  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, OTHER));
}

main()
  .then(() => {
    if (failures) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log("\nAll chat photo checks passed.");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
