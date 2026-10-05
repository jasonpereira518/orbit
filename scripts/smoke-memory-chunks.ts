/**
 * The chunker: boundaries, overlap, caps, and hashes that do not move.
 *
 * Three properties here are load-bearing and none is obvious from reading the code.
 *
 *  - The hash is what makes an edit cheap. `syncMemoryChunks` carries an embedding across a
 *    rewrite when the chunk's `content_hash` is unchanged, so a chunker that produced a
 *    different hash for identical text would silently re-embed a whole note — on the user's
 *    own key — every time they fixed a typo at the end of it.
 *  - The loop must terminate. It steps back by the overlap each time, and a break point that
 *    lands behind that step would walk backwards forever on some note nobody has written yet.
 *  - The cap is a cost ceiling. Every chunk is an embedding call.
 *
 * Pure: no network, no database. Run: npx tsx scripts/smoke-memory-chunks.ts
 */
import { buildMemoryChunks, chunkHeader, splitIntoPassages } from "../src/lib/memory-chunks";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

/**
 * Filler where every sentence is distinct, and which always ends on a word boundary.
 *
 * Both matter. Repeating filler makes `indexOf` below match the wrong copy of a passage, so
 * the word-boundary check reads the characters around some other occurrence — it reported a
 * chunker bug that was not there. And a source truncated mid-word would make the last
 * passage legitimately end mid-word, which is the source's doing, not the chunker's.
 */
function prose(chars: number): string {
  const parts: string[] = [];
  let length = 0;
  for (let i = 0; length < chars; i++) {
    const sentence = `Note ${i}: we talked about the roadmap and what quarter ${i} looks like. `;
    parts.push(sentence);
    length += sentence.length;
  }
  return parts.join("").trimEnd();
}

// --- short notes are left alone --------------------------------------------------------

const short = "Coffee with Ada. She is hiring a platform lead.";
check("a short note is one chunk", splitIntoPassages(short).length === 1);
check("and is not modified", splitIntoPassages(short)[0] === short);
check("empty text yields nothing", splitIntoPassages("").length === 0);
check("whitespace-only text yields nothing", splitIntoPassages("   \n\n  ").length === 0);

// --- long notes split, with overlap, on boundaries --------------------------------------

const long = prose(5000);
const passages = splitIntoPassages(long);
check("a 5,000-char note splits into several passages", passages.length > 3, String(passages.length));
check(
  "no passage runs far past the target size",
  passages.every((p) => p.length <= 1000),
  JSON.stringify(passages.map((p) => p.length))
);
check("every passage is trimmed", passages.every((p) => p === p.trim()));

// A real word-boundary test: find each passage in the source and look at the characters on
// either side of it. A split that landed mid-word would show a letter hard against the edge.
const midWord = passages.filter((p) => {
  const at = long.indexOf(p);
  if (at < 0) return true; // not found at all is worse than mid-word
  const before = at === 0 ? " " : long[at - 1];
  const after = at + p.length >= long.length ? " " : long[at + p.length];
  return /\S/.test(before) || /\S/.test(after);
});
check(
  "no passage starts or ends mid-word",
  midWord.length === 0,
  midWord.map((p) => `…${p.slice(0, 20)}|${p.slice(-20)}…`).join(" / ")
);

// Every character of the original must appear in some passage — a gap is a sentence that
// became unfindable, which is the exact bug this whole phase is about.
const rejoined = passages.join(" ");
const sampleAt = [0, 1200, 2500, 3900, 4800];
for (const at of sampleAt) {
  const needle = long.slice(at, at + 40).trim();
  check(
    `text at offset ${at} survives the split`,
    needle.length === 0 || rejoined.includes(needle),
    needle
  );
}

// Overlap: consecutive passages must share a tail/head, or a sentence on the seam is
// weakened in both.
let overlaps = 0;
for (let i = 1; i < passages.length; i++) {
  const prevTail = passages[i - 1].slice(-60);
  if (passages[i].includes(prevTail.slice(0, 30).trim())) overlaps++;
}
check("consecutive passages overlap", overlaps > 0, `${overlaps} of ${passages.length - 1}`);

// --- paragraph breaks are preferred over mid-sentence cuts ------------------------------

const paragraphs = `${prose(800)}\n\n${prose(800)}\n\n${prose(800)}`;
const split = splitIntoPassages(paragraphs);
check("a multi-paragraph note splits", split.length > 1, String(split.length));

// --- the cap holds ----------------------------------------------------------------------

const pathological = prose(200_000);
const capped = splitIntoPassages(pathological);
check("a pathological note is capped at 32 chunks", capped.length <= 32, String(capped.length));
check("and the cap still produced chunks rather than giving up", capped.length > 0);

// A note with no spaces at all has no break point anywhere — the loop must still terminate.
const unbroken = "x".repeat(20_000);
const unbrokenChunks = splitIntoPassages(unbroken);
check("a note with no break points anywhere still terminates", unbrokenChunks.length > 0 && unbrokenChunks.length <= 32, String(unbrokenChunks.length));

// --- headers and hashes -----------------------------------------------------------------

check(
  "the header carries date, kind and person",
  chunkHeader({ occurredAt: new Date("2026-03-12T00:00:00Z"), kindLabel: "Coffee", contactName: "Ada Lovelace" }) ===
    "2026-03-12 · Coffee · Ada Lovelace"
);
check(
  "a missing date or name does not leave a dangling separator",
  chunkHeader({ occurredAt: null, kindLabel: "Note", contactName: null }) === "Note"
);

const base = {
  text: long,
  occurredAt: new Date("2026-03-12T00:00:00Z"),
  kindLabel: "Coffee",
  contactId: "11111111-1111-4111-8111-111111111111",
  contactName: "Ada Lovelace",
  contactIds: ["22222222-2222-4222-8222-222222222222"],
};

const first = buildMemoryChunks(base);
const second = buildMemoryChunks(base);
check(
  "the same input produces the same hashes — an unchanged note must not re-embed",
  JSON.stringify(first.map((c) => c.contentHash)) === JSON.stringify(second.map((c) => c.contentHash))
);
check(
  "every chunk carries the header, so a citation snippet is self-describing",
  first.every((c) => c.content.startsWith("2026-03-12 · Coffee · Ada Lovelace\n")),
  first[0]?.content.slice(0, 60)
);
check(
  "chunk indexes are dense and ordered",
  first.every((c, i) => c.chunkIndex === i)
);
check(
  "the subject is folded into contactIds alongside the mentions",
  first[0].contactIds.includes(base.contactId) && first[0].contactIds.includes(base.contactIds[0]),
  JSON.stringify(first[0].contactIds)
);
check(
  "contactIds are deduped",
  new Set(first[0].contactIds).size === first[0].contactIds.length
);
check("the date rides every chunk, so date-scoped recall works", first.every((c) => c.occurredAt !== null));

// Editing the tail must leave the leading chunks' hashes untouched, or the carry-forward in
// syncMemoryChunks buys nothing.
const edited = buildMemoryChunks({ ...base, text: `${long} One more thing: she said yes.` });
const unchangedLeading = first
  .slice(0, Math.max(first.length - 2, 0))
  .every((c, i) => edited[i]?.contentHash === c.contentHash);
check(
  "editing the end of a note leaves the earlier chunks' hashes unchanged",
  unchangedLeading,
  `${first.length} before, ${edited.length} after`
);

check("no text, no chunks", buildMemoryChunks({ ...base, text: null }).length === 0);

console.log(
  failures === 0 ? "\nsmoke-memory-chunks: all checks passed" : `\nsmoke-memory-chunks: ${failures} FAILED`
);
process.exit(failures === 0 ? 0 : 1);
