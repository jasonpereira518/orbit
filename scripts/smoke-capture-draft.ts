/**
 * The capture page's client-side memory: the autosaved draft, the palette's "Capture this"
 * handoff, and the arithmetic that shrinks a phone photo before upload.
 *
 * Pure — every function takes the `Storage` it works on, so an in-memory one stands in for
 * localStorage and sessionStorage, and the clock is passed in rather than read.
 *
 * Run: npx tsx scripts/smoke-capture-draft.ts
 */
import {
  DRAFT_PHOTO_TTL_MS,
  DRAFT_TTL_MS,
  captureDraftKey,
  clearCaptureDraft,
  readCaptureDraft,
  writeCaptureDraft,
} from "../src/lib/capture-draft";
import {
  HANDOFF_MAX_AGE_MS,
  appendHandoff,
  takeCaptureHandoff,
  writeCaptureHandoff,
} from "../src/lib/capture-handoff";
import { UPLOAD_MAX_EDGE, fitWithin } from "../src/lib/capture-image-shrink";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

/** Storage that throws on every call, like Safari's private mode used to. */
const brokenStorage = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("quota");
  },
  removeItem: () => {
    throw new Error("denied");
  },
};

const T0 = Date.UTC(2026, 8, 11, 12, 0, 0);

console.log("Draft keys");
check("scoped by account and by person", captureDraftKey("u1", "c1") !== captureDraftKey("u1", null));
check("two accounts on one browser never share a draft", captureDraftKey("u1", null) !== captureDraftKey("u2", null));

console.log("\nDrafts");
{
  const s = memoryStorage();
  const key = captureDraftKey("u1", null);
  writeCaptureDraft(s, key, { notes: "Met Sarah at AWS", sources: ["text"], photoIds: ["p1"] }, T0);
  const back = readCaptureDraft(s, key, T0 + 60_000);
  check("a written draft reads back", back?.notes === "Met Sarah at AWS" && back.photoIds[0] === "p1" && back.savedAt === T0);

  check(
    "its photos are dropped before the server prunes them, the text is kept",
    (() => {
      const later = readCaptureDraft(s, key, T0 + DRAFT_PHOTO_TTL_MS + 1);
      return later?.notes === "Met Sarah at AWS" && later.photoIds.length === 0;
    })()
  );

  check("a week-old draft is gone", readCaptureDraft(s, key, T0 + DRAFT_TTL_MS + 1) === null);
  check("  and removed, not just ignored", !s.map.has(key));

  writeCaptureDraft(s, key, { notes: "still typing", sources: [], photoIds: [] }, T0);
  writeCaptureDraft(s, key, { notes: "   ", sources: [], photoIds: [] }, T0 + 1);
  check("clearing the textarea removes the draft rather than saving an empty one", !s.map.has(key));

  writeCaptureDraft(s, key, { notes: "", sources: ["photos:1"], photoIds: ["p9"] }, T0);
  check("photos alone are still worth restoring", readCaptureDraft(s, key, T0)?.photoIds[0] === "p9");
  check(
    "  until they expire, when there is nothing left to restore",
    readCaptureDraft(s, key, T0 + DRAFT_PHOTO_TTL_MS + 1) === null && !s.map.has(key)
  );

  s.map.set(key, "{not json");
  check("junk in storage reads as no draft", readCaptureDraft(s, key, T0) === null && !s.map.has(key));
  s.map.set(key, JSON.stringify({ notes: 42, sources: [], photoIds: [], savedAt: T0 }));
  check("a draft of the wrong shape reads as no draft", readCaptureDraft(s, key, T0) === null);

  writeCaptureDraft(s, key, { notes: "x", sources: [], photoIds: [] }, T0);
  clearCaptureDraft(s, key);
  check("clearing removes it", !s.map.has(key));

  check("storage that throws never throws back — read", readCaptureDraft(brokenStorage, key, T0) === null);
  let threw = false;
  try {
    writeCaptureDraft(brokenStorage, key, { notes: "x", sources: [], photoIds: [] }, T0);
    clearCaptureDraft(brokenStorage, key);
  } catch {
    threw = true;
  }
  check("  — write and clear", !threw);
}

console.log("\nCapture this (handoff)");
{
  const s = memoryStorage();
  writeCaptureHandoff(s, "  met Sarah at AWS, she's moving to Stripe  ", T0);
  check("a fresh handoff is taken, trimmed", takeCaptureHandoff(s, T0 + 1000) === "met Sarah at AWS, she's moving to Stripe");
  check("  and only once", takeCaptureHandoff(s, T0 + 1000) === null);

  writeCaptureHandoff(s, "old note", T0);
  check("a stale handoff is not delivered", takeCaptureHandoff(s, T0 + HANDOFF_MAX_AGE_MS + 1) === null);
  check("  and does not linger", !s.map.size);

  s.map.set("orbit:capture-handoff", "garbage");
  check("junk is not delivered", takeCaptureHandoff(s, T0) === null);
  check("broken storage delivers nothing, quietly", takeCaptureHandoff(brokenStorage, T0) === null);

  check("appends after existing notes with a blank line", appendHandoff("First note\n", "Second") === "First note\n\nSecond");
  check("an empty box just takes the text", appendHandoff("  \n", "Only") === "Only");
}

console.log("\nPhoto shrinking");
{
  const phone = fitWithin(4032, 3024);
  check("a 12 MP phone photo shrinks to the upload edge", phone.width === UPLOAD_MAX_EDGE && phone.height === 1500, JSON.stringify(phone));
  const portrait = fitWithin(3024, 4032);
  check("  portrait keeps its orientation", portrait.height === UPLOAD_MAX_EDGE && portrait.width === 1500, JSON.stringify(portrait));
  const small = fitWithin(1200, 800);
  check("a small photo is never enlarged", small.width === 1200 && small.height === 800);
  check("a degenerate size is left alone", fitWithin(0, 0).width === 0);
}

console.log("\nsmoke-capture-draft: all checks passed");
