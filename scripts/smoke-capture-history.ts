/**
 * The capture history and the photos behind it, end to end against PGlite.
 *
 * What this pins, in the order a capture lives it:
 *   - a photo is re-encoded on the way in: shrunk, JPEG, and stripped of its metadata
 *   - an upload stores photos unattached; a save claims them, and only its owner's
 *   - a forged or reused id cannot move a photo between captures or between people
 *   - the history pages newest-first with no repeats or gaps, even across rows that share
 *     a millisecond (the reason its cursor is Postgres text, not a JS Date)
 *   - the daily prune removes unsaved captures' photos and nothing else
 *
 * Runs with Blob storage forced off, so every photo is stored inline — the configuration
 * Orbit is in without a provisioned store, and the one a smoke run can check byte for byte.
 *
 * Run: npx tsx scripts/smoke-capture-history.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.BLOB_STORE_ID;
delete process.env.VERCEL_OIDC_TOKEN;
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-capture-history";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-capture-history";

import sharp from "sharp";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { capturePhotos, noteBatches, reminders, userSettings } from "../src/db/schema";
import {
  CAPTURE_PHOTO_MAX_EDGE,
  attachCapturePhotos,
  discardCapturePhotos,
  encodeCapturePhoto,
  listCapturePhotosForBatches,
  pruneUnattachedCapturePhotos,
  purgeCapturePhotosForUser,
  storeCapturePhotos,
} from "../src/lib/capture-photos";
import { listCaptureHistoryFor } from "../src/lib/capture-history";
import { saveNoteBatch } from "../src/lib/note-batch-save";
import {
  captureExcerpt,
  captureHistoryTitle,
  captureSourceKinds,
  emptyNoteBatchResult,
} from "../src/lib/note-batches";
import { hashSourceNote } from "../src/lib/suggested-reminder-utils";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-capture-history-user";
const OTHER = "smoke-capture-history-other";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  for (const user of [USER, OTHER]) {
    await purgeCapturePhotosForUser(user);
    await db.delete(reminders).where(eq(reminders.userId, user));
    await db.delete(noteBatches).where(eq(noteBatches.userId, user));
    await db.delete(userSettings).where(eq(userSettings.userId, user));
  }
  await ensureUserSettings(USER);
}

/** A wide photo with EXIF on it, so the re-encode has something to shrink and strip. */
async function fixturePhotoBase64() {
  const buf = await sharp({
    create: { width: 3200, height: 1200, channels: 3, background: { r: 200, g: 180, b: 90 } },
  })
    .withExif({ IFD0: { Copyright: "smoke fixture", Artist: "a phone with GPS on" } })
    .jpeg()
    .toBuffer();
  return buf.toString("base64");
}

function pureChecks() {
  console.log("Pure helpers");
  check("typed notes read as text", captureSourceKinds([]).join() === "text");
  check(
    "ingest labels fold into kinds, in display order",
    captureSourceKinds(["text", "photos:2", "voice:rec.wav", "calendar:a.ics"]).join() ===
      "voice,photo,calendar,text"
  );
  check("an uploaded text file is a file, not typing", captureSourceKinds(["text:notes.md"]).join() === "file");
  check("stored kinds survive a second pass unchanged", captureSourceKinds(["voice", "photo", "file"]).join() === "voice,photo,file");
  check(
    "unknown or non-string labels are dropped, never stored",
    captureSourceKinds(["<script>", 42, null, "email:x.eml"]).join() === "email"
  );

  const result = emptyNoteBatchResult();
  result.participants = ["Sarah Chen", "Marcus Lee", "Priya Nair", "Sarah Chen"].map((name, i) => ({
    contactId: `c${i}`,
    interactionId: null,
    name,
    created: true,
    duplicate: false,
  }));
  check("title names two people and counts the rest", captureHistoryTitle(result) === "Sarah Chen, Marcus Lee +1 more", String(captureHistoryTitle(result)));
  const datesOnly = emptyNoteBatchResult();
  datesOnly.reminders = [{ id: "r", contactId: null, title: "Board review", dueIso: "2026-10-15", dateBasis: "absolute", rawDatePhrase: null, sourceExcerpt: null }];
  check("a dates-only capture is titled by its first reminder", captureHistoryTitle(datesOnly) === "Board review");
  check("nothing to title → null", captureHistoryTitle(emptyNoteBatchResult()) === null);

  check("short notes pass through, whitespace collapsed", captureExcerpt("  Met   Sarah\n\nat AWS  ") === "Met Sarah at AWS");
  const long = captureExcerpt("word ".repeat(100), 40);
  check("long notes cut on a word boundary with an ellipsis", long.endsWith("…") && long.length <= 41 && !long.includes("wor…"), long);
}

async function main() {
  pureChecks();
  await reset();
  const db = await getDb();
  const photo = await fixturePhotoBase64();

  console.log("\nEncoding");
  const encoded = await encodeCapturePhoto(Buffer.from(photo, "base64"));
  check("a real photo encodes", encoded !== null);
  const meta = await sharp(encoded!.buf).metadata();
  check("  as JPEG", meta.format === "jpeg");
  check(
    "  shrunk to the long-edge cap, aspect kept",
    encoded!.width === CAPTURE_PHOTO_MAX_EDGE && encoded!.height === 600,
    `${encoded!.width}x${encoded!.height}`
  );
  check("  with its EXIF stripped", !meta.exif, "exif survived the re-encode");
  check("junk bytes are refused, not stored", (await encodeCapturePhoto(Buffer.from("not an image"))) === null);

  console.log("\nUpload → save");
  const stored = await storeCapturePhotos(USER, [
    { filename: "whiteboard.jpg", base64: photo },
    { filename: "broken.heic", base64: Buffer.from("garbage").toString("base64") },
    { filename: "card\u0000.jpg", base64: photo },
  ]);
  check("the two decodable photos are kept, the junk one skipped", stored.length === 2, String(stored.length));
  const rows = await db.select().from(capturePhotos).where(eq(capturePhotos.userId, USER));
  check("  stored inline without a Blob store", rows.every((r) => r.storage === "inline" && r.inlineData && !r.blobUrl));
  check("  unattached until a save claims them", rows.every((r) => r.noteBatchId === null));
  check("  control characters stripped from the file name", rows.some((r) => r.fileName === "card.jpg"));

  // A real save, through the path the action uses, so input_sources is proven end to end.
  const note = "Board review on October 15th.";
  const saved = await saveNoteBatch(USER, {
    sourceText: note,
    sourceHash: hashSourceNote(note),
    anchorIso: "2026-09-01",
    anchorBasis: "upload",
    entryPoint: "capture",
    participants: [],
    commitments: [
      { title: "Board review", description: null, rawDatePhrase: "October 15th", dueDateIso: "2026-10-15", yearInferred: true, personName: null, actionKind: "meet", confidenceScore: 90, sourceExcerpt: note, dateBasis: "absolute", anchorIso: "2026-09-01" },
    ],
    skipped: { relative: 0, unverifiable: 0, past: 0 },
    inputSources: captureSourceKinds(["photos:2"]),
  });
  const savedRow = await db.query.noteBatches.findFirst({ where: eq(noteBatches.id, saved.batchId) });
  check("the batch records how its notes arrived", savedRow?.inputSources.join() === "photo", JSON.stringify(savedRow?.inputSources));

  check(
    "someone else cannot claim these photos",
    (await attachCapturePhotos(OTHER, saved.batchId, stored.map((s) => s.id))) === 0
  );
  check(
    "the owner's save claims both",
    (await attachCapturePhotos(USER, saved.batchId, [...stored.map((s) => s.id), stored[0]!.id])) === 2
  );
  const [otherBatch] = await db
    .insert(noteBatches)
    .values({ userId: USER, sourceHash: "h-other", sourceText: "other", anchorDate: new Date(), result: emptyNoteBatchResult() })
    .returning();
  check(
    "a claimed photo cannot be moved to another capture",
    (await attachCapturePhotos(USER, otherBatch.id, [stored[0]!.id])) === 0
  );
  const listed = await listCapturePhotosForBatches(USER, [saved.batchId]);
  check("photos list in upload order", listed.map((p) => p.id).join() === stored.map((s) => s.id).join());
  check("  and the list never carries the bytes", listed.every((p) => !("inlineData" in p)));
  check("  scoped to the owner", (await listCapturePhotosForBatches(OTHER, [saved.batchId])).length === 0);

  console.log("\nHistory");
  // Thirteen more captures, ten of them in the same instant. Postgres keeps microseconds and
  // a JS Date keeps milliseconds, so a cursor that went through a Date would split this
  // group wrongly and repeat or drop rows at the page boundary.
  const sameInstant = new Date("2026-09-10T12:00:00.123Z");
  await db.insert(noteBatches).values(
    Array.from({ length: 13 }, (_, i) => ({
      userId: USER,
      sourceHash: `h-${i}`,
      sourceText: `Capture number ${i}`,
      anchorDate: sameInstant,
      result: emptyNoteBatchResult(),
      createdAt: i < 10 ? sameInstant : new Date(sameInstant.getTime() - (i + 1) * 60_000),
    }))
  );
  await db.execute(
    sql`UPDATE note_batches SET created_at = created_at + interval '456 microseconds' WHERE user_id = ${USER} AND source_hash LIKE 'h-%' AND created_at = ${sameInstant.toISOString()}::timestamptz AND source_hash IN ('h-0','h-1','h-2','h-3','h-4')`
  );

  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await listCaptureHistoryFor(USER, { cursor, limit: 4 });
    seen.push(...page.items.map((i) => i.id));
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor && pages < 20);
  const total = 15; // 13 + the saved capture + otherBatch
  check("paging visits every capture exactly once", seen.length === total && new Set(seen).size === total, `${seen.length} seen, ${new Set(seen).size} unique`);
  check("  in four pages of four", pages === 4, String(pages));

  const firstPage = await listCaptureHistoryFor(USER, { limit: 50 });
  const created = firstPage.items.map((i) => Date.parse(i.createdAt));
  check("newest first", created.every((t, i) => i === 0 || created[i - 1]! >= t));
  const withPhotos = firstPage.items.find((i) => i.id === saved.batchId)!;
  check("the photo capture shows its count and thumbnails", withPhotos.photoCount === 2 && withPhotos.thumbnailIds.length === 2);
  check("  and is labelled a photo capture", withPhotos.kinds.includes("photo"));
  check("  titled by its reminder", withPhotos.title === "Board review" && withPhotos.reminderCount === 1);
  check("a pre-label capture with no photo reads as typed notes", firstPage.items.find((i) => i.id === otherBatch.id)!.kinds.join() === "text");
  check("a junk cursor falls back to the first page", (await listCaptureHistoryFor(USER, { cursor: "'; drop table x;--|nope", limit: 50 })).items.length === total);
  check("another user's history is empty", (await listCaptureHistoryFor(OTHER)).items.length === 0);

  console.log("\nDiscard and prune");
  const [abandoned, fresh] = await storeCapturePhotos(USER, [
    { filename: "abandoned.jpg", base64: photo },
    { filename: "fresh.jpg", base64: photo },
  ]);
  const [discardMe] = await storeCapturePhotos(USER, [{ filename: "failed.jpg", base64: photo }]);
  await discardCapturePhotos(USER, [discardMe!.id, stored[0]!.id]);
  const afterDiscard = await db.select({ id: capturePhotos.id }).from(capturePhotos).where(inArray(capturePhotos.id, [discardMe!.id, stored[0]!.id]));
  check("discard removes an unattached photo and never an attached one", afterDiscard.length === 1 && afterDiscard[0]!.id === stored[0]!.id);

  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await db.update(capturePhotos).set({ createdAt: twoDaysAgo }).where(inArray(capturePhotos.id, [abandoned!.id, stored[0]!.id]));
  const pruned = await pruneUnattachedCapturePhotos();
  const left = new Set(
    (await db.select({ id: capturePhotos.id }).from(capturePhotos).where(eq(capturePhotos.userId, USER))).map((r) => r.id)
  );
  check("the prune removed exactly the stale unattached photo", pruned === 1 && !left.has(abandoned!.id), String(pruned));
  check("  an old photo that belongs to a capture stays", left.has(stored[0]!.id));
  check("  a fresh unattached photo stays (its save may still be coming)", left.has(fresh!.id));

  await purgeCapturePhotosForUser(USER);
  check("purge leaves the user no photos", (await db.select({ id: capturePhotos.id }).from(capturePhotos).where(eq(capturePhotos.userId, USER))).length === 0);

  await reset();
  console.log("\nsmoke-capture-history: all checks passed");
}

run(main);
