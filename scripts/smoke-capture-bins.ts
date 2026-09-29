/**
 * Sorting a dropped folder into notes, with no browser.
 *
 * THE PROPERTY THIS EXISTS FOR: every file is in exactly one place. Not zero — a file that
 * quietly fell out of the dialog is a meeting somebody believes they uploaded and did not —
 * and not two, which is the same bytes read twice, billed twice, and filed on two timelines.
 *
 * So the invariant is re-checked after EVERY operation below, including the ones that look
 * obviously safe. The ones that look obviously safe are the ones that quietly stop being it.
 *
 * The second half of the file is about a different way to lose a note: refusing to upload
 * one that would have been fine. A bin is sized by what its files will weigh once they are
 * PREPARED, and preparation moves that number in both directions — photos are re-encoded
 * down, a PDF is rasterized up — so checking the size on disk refuses a bin of whiteboard
 * photos while waving through a PDF that cannot fit.
 *
 * Then two ways a file is staged and still not read: the same BYTES twice (deduped by
 * content hash, whatever the files are called), and a file unticked — or already captured,
 * which starts unticked. Neither may break the invariant, and neither may reach an upload.
 *
 * Run: npx tsx scripts/smoke-capture-bins.ts
 */
import {
  MAX_STAGED_FILES,
  addBin,
  binOf,
  combineAll,
  emptyState,
  invariantBroken,
  isIncluded,
  moveFiles,
  oversizedUploads,
  planUploads,
  removeBin,
  removeFile,
  renameBin,
  separateTray,
  setBinAnchor,
  setExcluded,
  stageFiles,
  type SorterState,
  type StagedFile,
} from "../src/lib/capture/bins";
import {
  estimatePreparedBytes,
  prepareNotice,
  prepareUploadFiles,
  type PageRenderer,
} from "../src/lib/capture/prepare-upload";
import type { ScanPage } from "../src/lib/scan-capture";
import { CAPTURE_MAX_UPLOAD_BYTES } from "../src/lib/capture-limits";
import { MAX_SCAN_PAGES, SCAN_TARGET_BYTES } from "../src/lib/scan-image";
import { hashFileBytes, hashFilesSequentially, isFileHash } from "../src/lib/capture/file-hash";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Every assertion goes through here, so the invariant is never the thing nobody checked. */
function intact(label: string, state: SorterState, ok: boolean, detail = "") {
  const broken = invariantBroken(state);
  check(label, ok && broken === null, broken ?? detail);
  return state;
}

let n = 0;
// Every file gets its own hash unless one is given: distinct bytes, which is what the
// placement tests below are about. The dedupe tests pass a shared one on purpose.
const file = (name: string, size = 100, path = "", type = "", hash?: string): StagedFile => {
  const id = `f${++n}`;
  return { id, name, size, type, lastModified: 0, path, hash: hash ?? `hash-${id}` };
};

const seed = (f: StagedFile) => ({ name: f.name.replace(/\.[^.]+$/, ""), anchorIso: null });
const ids = (mint: string) => () => `${mint}${++n}`;

console.log("\nstaging");

let s = emptyState();
{
  const a = file("standup.md");
  const b = file("whiteboard.jpg", 2048, "q1");
  const out = stageFiles(s, [a, b]);
  s = intact("a drop lands in the tray", out.state, out.state.trayIds.length === 2);
  check("  nothing is binned yet", out.state.bins.length === 0);
  check("  and the folder path is kept", out.state.files[1]!.path === "q1");

  // Dropping the same folder twice is a thing people do when the first drop looks like it
  // did nothing. It must not double the files.
  const again = stageFiles(out.state, [a, b]);
  intact("re-staging the same ids changes nothing", again.state, again.state.files.length === 2);
}
{
  const many = Array.from({ length: MAX_STAGED_FILES + 5 }, (_, i) => file(`n${i}.md`));
  const out = stageFiles(emptyState(), many);
  intact("a huge folder is capped, not refused", out.state, out.state.files.length === MAX_STAGED_FILES);
  check("  and says how many it turned away", out.rejected === 5, String(out.rejected));
}

console.log("\nmoving between the tray and bins");

{
  let st = stageFiles(emptyState(), [file("a.md"), file("b.md"), file("c.md")]).state;
  const [a, b, c] = st.files.map((f) => f.id) as [string, string, string];
  st = addBin(st, "bin1", "Monday");
  st = intact("a new bin is empty", st, st.bins[0]!.fileIds.length === 0);

  st = intact("a file moves in", moveFiles(st, [a], "bin1"), true);
  check("  it leaves the tray", !st.trayIds.includes(a));
  check("  and the bin knows it", binOf(st, a)?.id === "bin1");

  st = addBin(st, "bin2", "Tuesday");
  st = intact("moving between bins detaches first", moveFiles(st, [a], "bin2"), true);
  check("  the old bin is empty", st.bins.find((x) => x.id === "bin1")!.fileIds.length === 0);
  check("  the new one holds it", binOf(st, a)?.id === "bin2");

  st = intact("a multi-select moves together", moveFiles(st, [b, c], "bin1"), true);
  check("  both landed", st.bins.find((x) => x.id === "bin1")!.fileIds.length === 2);

  const backInTray = moveFiles(st, [b, c], null);
  st = intact("null puts them back in the tray", backInTray, backInTray.trayIds.length === 2);

  // A drop onto a bin that was removed mid-drag. Nothing is lost.
  const before = JSON.stringify(st);
  st = intact("a move to a bin that no longer exists is a no-op", moveFiles(st, [b], "gone"), JSON.stringify(st) === before);
  // And an id that was never staged cannot conjure a placement.
  st = intact("moving an unknown id is a no-op", moveFiles(st, ["nope"], "bin1"), true);
}

console.log("\nremoving");

{
  let st = stageFiles(emptyState(), [file("a.md"), file("b.md")]).state;
  const [a, b] = st.files.map((f) => f.id) as [string, string];
  st = moveFiles(addBin(st, "bin1"), [a, b], "bin1");

  const unbinned = removeBin(st, "bin1");
  st = intact("removing a bin returns its files to the tray", unbinned, unbinned.trayIds.length === 2);
  check("  and the bin is gone", st.bins.length === 0);

  st = moveFiles(addBin(st, "bin2"), [a], "bin2");
  const minusA = removeFile(st, a);
  st = intact("removing a file takes it out of its bin", minusA, minusA.files.length === 1);
  check("  the bin survives, empty", st.bins.length === 1 && st.bins[0]!.fileIds.length === 0);
  const minusB = removeFile(st, b);
  st = intact("removing a tray file works too", minusB, minusB.files.length === 0);
}

console.log("\nthe two buttons at the top");

{
  let st = stageFiles(emptyState(), [file("a.md"), file("b.md"), file("c.md")]).state;
  const [a] = st.files.map((f) => f.id) as [string];
  st = moveFiles(addBin(st, "kept", "Whiteboard"), [a], "kept");

  // Deliberately the TRAY and not everything: somebody who has spent a minute grouping
  // photos must not lose it to a control they read as "sort out the rest".
  const separated = separateTray(st, ids("s"), seed);
  st = intact("Each its own note only touches the tray", separated, separated.trayIds.length === 0);
  check("  the hand-made bin survives untouched", st.bins.find((b) => b.id === "kept")?.fileIds.length === 1);
  check("  and the other two got a bin each", st.bins.length === 3, String(st.bins.length));
  check("  named from the file, without the extension", st.bins.some((b) => b.name === "b"), JSON.stringify(st.bins.map((b) => b.name)));

  const noop = separateTray(st, ids("s"), seed);
  st = intact("Each its own note on an empty tray is a no-op", noop, noop.bins.length === 3);

  const combined = intact("All one note collapses everything", combineAll(st, ids("c"), seed), true);
  check("  into exactly one bin", combined.bins.length === 1 && combined.bins[0]!.fileIds.length === 3);
  check("  with an empty tray", combined.trayIds.length === 0);
}

console.log("\nwhat pressing Read will actually upload");

{
  let st = stageFiles(emptyState(), [file("one.md"), file("two.jpg", 500), file("three.jpg", 700)]).state;
  const [one, two, three] = st.files.map((f) => f.id) as [string, string, string];
  st = moveFiles(addBin(st, "bin1", "Whiteboard"), [two, three], "bin1");

  const plans = planUploads(st, seed);
  check("one entry per bin, one per leftover", plans.length === 2, JSON.stringify(plans.map((p) => p.label)));
  const binned = plans.find((p) => p.binId === "bin1")!;
  check("  the bin carries both files", binned.fileIds.length === 2);
  // The cap is on the REQUEST, so a bin's total is what matters — four photos that each fit
  // can add up to one upload that does not.
  check("  and their total size", binned.bytes === 1200, String(binned.bytes));
  check("  labelled with the bin's name", binned.label === "Whiteboard");

  const loose = plans.find((p) => p.binId === null)!;
  check("a file left in the tray still becomes a note", loose.fileIds[0] === one);
  check("  named from the file", loose.label === "one");

  // An empty bin is a bin somebody made and did not use, not a note about nothing.
  const withEmpty = addBin(st, "empty", "Unused");
  check("an empty bin uploads nothing", planUploads(withEmpty, seed).length === 2);

  // A renamed bin is what the capture gets called.
  const renamed = planUploads(renameBin(st, "bin1", "Board photos"), seed);
  check("the bin's name reaches the plan", renamed.find((p) => p.binId === "bin1")?.label === "Board photos");
  // A blank name falls back rather than uploading an untitled note.
  const blank = planUploads(renameBin(st, "bin1", "   "), seed);
  check("  a blank name falls back to the first file", blank.find((p) => p.binId === "bin1")?.label === "two.jpg");

  const dated = planUploads(setBinAnchor(st, "bin1", "2026-03-04"), seed);
  check("the bin's date reaches the plan", dated.find((p) => p.binId === "bin1")?.anchorIso === "2026-03-04");
}

console.log("\nthe size cap is per upload, not per file");

{
  let st = stageFiles(emptyState(), [file("a.jpg", 600), file("b.jpg", 600)]).state;
  const [a, b] = st.files.map((f) => f.id) as [string, string];

  // Each fits on its own.
  check("separately, both fit", oversizedUploads(planUploads(st, seed), 1000).length === 0);

  st = moveFiles(addBin(st, "bin1"), [a, b], "bin1");
  const over = oversizedUploads(planUploads(st, seed), 1000);
  check("together in one bin, they do not", over.length === 1 && over[0]!.binId === "bin1", String(over.length));
  // Reported, never auto-split: splitting would silently make two meetings out of the one
  // the person just said was one.
  check("  and the bin is left exactly as it was", st.bins[0]!.fileIds.length === 2);
}

console.log("\nwhat a note will actually weigh, which is not what was picked");

{
  const MB = 1024 * 1024;
  // The case the sorting dialog exists to encourage. Five phone photos of one whiteboard
  // total 25MB on disk and would be refused on raw bytes — but each becomes at most one
  // page, so the note is nowhere near the cap. Refusing it would be the feature declining
  // its own worked example.
  const photos = Array.from({ length: 5 }, (_, i) => file(`board${i}.jpg`, 5 * MB, "", "image/jpeg"));
  let st = stageFiles(emptyState(), photos).state;
  st = moveFiles(addBin(st, "bin1", "Whiteboard"), st.files.map((f) => f.id), "bin1");
  const plan = planUploads(st, seed, estimatePreparedBytes)[0]!;
  check("the raw size is still reported honestly", plan.bytes === 25 * MB, String(plan.bytes));
  check("  but five photos are priced as five pages", plan.uploadBytes === 5 * SCAN_TARGET_BYTES, String(plan.uploadBytes));
  check("  so a bin of whiteboard photos is not refused",
    oversizedUploads([plan], CAPTURE_MAX_UPLOAD_BYTES).length === 0);
  check("  which checking raw bytes would have done",
    oversizedUploads([{ ...plan, uploadBytes: plan.bytes }], CAPTURE_MAX_UPLOAD_BYTES).length === 1);

  // And the other direction, which fails at the server rather than in the dialog: a small
  // PDF becomes a dozen JPEG pages that weigh far more than it did.
  let pdfState = stageFiles(emptyState(), [file("report.pdf", 2 * MB, "", "application/pdf")]).state;
  pdfState = moveFiles(addBin(pdfState, "bin1"), [pdfState.files[0]!.id], "bin1");
  const pdfPlan = planUploads(pdfState, seed, estimatePreparedBytes)[0]!;
  check("a 2MB PDF is priced at the whole page budget",
    pdfPlan.uploadBytes === MAX_SCAN_PAGES * SCAN_TARGET_BYTES, String(pdfPlan.uploadBytes));
  check("  and the budget still fits in one request",
    pdfPlan.uploadBytes < CAPTURE_MAX_UPLOAD_BYTES,
    `${pdfPlan.uploadBytes} vs ${CAPTURE_MAX_UPLOAD_BYTES}`);

  // Text is read from its own bytes server-side, so it is priced at what it is.
  check("a text note is priced at its size", estimatePreparedBytes([file("n.md", 4096)]) === 4096);
  check("no files weigh nothing", estimatePreparedBytes([]) === 0);
  // Classification falls back to the extension, because engines leave `type` blank often.
  check("a typeless .pdf is still a PDF",
    estimatePreparedBytes([file("x.pdf", 10)]) === MAX_SCAN_PAGES * SCAN_TARGET_BYTES);
  // More images than the budget cannot cost more than the budget.
  const many = Array.from({ length: MAX_SCAN_PAGES + 8 }, (_, i) => file(`p${i}.jpg`, 10, "", "image/jpeg"));
  check("more photos than the cap are priced at the cap",
    estimatePreparedBytes(many) === MAX_SCAN_PAGES * SCAN_TARGET_BYTES);
}

console.log("\ntruncation and unreadable files are always said out loud");

{
  check("a clean note says nothing",
    prepareNotice({ files: [], droppedPages: 0, failures: [] }) === null);
  const truncated = prepareNotice({ files: [], droppedPages: 9, failures: [] });
  check("a truncated note names the cap", truncated?.includes(String(MAX_SCAN_PAGES)) === true, truncated ?? "null");
  const oneBad = prepareNotice({ files: [], droppedPages: 0, failures: [{ name: "a.heic", message: "a.heic is an iPhone photo" }] });
  check("one unreadable file is named", oneBad === "a.heic is an iPhone photo", oneBad ?? "null");
  const manyBad = prepareNotice({
    files: [],
    droppedPages: 0,
    failures: [{ name: "a", message: "x" }, { name: "b", message: "y" }],
  });
  check("several are counted rather than listed", manyBad === "2 files couldn’t be read", manyBad ?? "null");
  const both = prepareNotice({ files: [], droppedPages: 2, failures: [{ name: "a", message: "x" }] });
  check("both at once are joined, not dropped", both?.includes("·") === true, both ?? "null");
}

/**
 * A renderer that does everything the real one does except touch a canvas: it hands back
 * page-shaped objects, honours the budget it is given, and records what it was asked for.
 *
 * The rasterizing itself needs a browser and is not the part that breaks. THE BUDGET
 * ARITHMETIC IS. An off-by-one there does not throw — it quietly returns a note one page
 * short, and the page that went missing is indistinguishable from a page that had nothing
 * written on it.
 */
function fakeRenderer(pdfPages: Record<string, number> = {}) {
  const asked: { name: string; budget: number }[] = [];
  const revoked: string[] = [];
  const page = (filename: string, body: string): ScanPage => ({
    id: filename,
    filename,
    mimeType: "image/jpeg",
    base64: Buffer.from(body, "utf8").toString("base64"),
    previewUrl: `blob:${filename}`,
    width: 10,
    height: 10,
    bytes: body.length,
  });
  const renderer: PageRenderer = {
    rasterizePdf: async (f, budget) => {
      asked.push({ name: f.name, budget });
      const total = pdfPages[f.name] ?? 1;
      const kept = Math.max(0, Math.min(total, budget));
      return {
        pages: Array.from({ length: kept }, (_, i) =>
          page(`${f.name}-p${i + 1}.jpg`, `page ${i + 1} of ${f.name}`)
        ),
        dropped: total - kept,
      };
    },
    normalizeImageFile: async (f) => {
      asked.push({ name: f.name, budget: 1 });
      if (f.name.endsWith(".heic")) throw new Error("no decoder");
      return page(`${f.name}.jpg`, `image ${f.name}`);
    },
    releaseScanPage: (pg) => void revoked.push(pg.previewUrl),
  };
  return { renderer, asked, revoked };
}

const asFile = (name: string, type = "", body = "x") => new File([body], name, { type });

async function preparation() {
  console.log("\npreparing one note's files");

  {
    // The bug this whole change exists for: a PDF used to go up untouched and be refused by
    // name. It must come back as images, and no PDF may survive into the request.
    const { renderer } = fakeRenderer({ "notes.pdf": 3 });
    const out = await prepareUploadFiles([asFile("notes.pdf", "application/pdf")], renderer);
    check(
      "a PDF becomes pages, and no PDF survives",
      out.files.length === 3 && out.files.every((f) => f.type === "image/jpeg"),
      JSON.stringify(out.files.map((f) => f.name))
    );
    check("  nothing was truncated", out.droppedPages === 0 && out.failures.length === 0);
    // The bytes have to survive base64, or the upload is a dozen unreadable files.
    const first = await out.files[0]!.text();
    check("  and the page's bytes come back intact", first === "page 1 of notes.pdf", first);
  }

  {
    const { renderer, asked } = fakeRenderer({ "long.pdf": 40 });
    const out = await prepareUploadFiles([asFile("long.pdf", "application/pdf")], renderer);
    check("a long PDF stops at the cap", out.files.length === MAX_SCAN_PAGES, String(out.files.length));
    check("  and says how much it left", out.droppedPages === 40 - MAX_SCAN_PAGES, String(out.droppedPages));
    check(
      "  having been told the budget up front, not slicing after",
      asked[0]!.budget === MAX_SCAN_PAGES,
      String(asked[0]!.budget)
    );
  }

  {
    // THE REGRESSION THIS PINS. Four photos and a PDF in one note is ONE request, so the
    // PDF gets eight pages, not twelve. Getting it wrong builds a request that is too big
    // and fails at the server — after the person has waited for twelve pages to render.
    const { renderer, asked } = fakeRenderer({ "deck.pdf": 30 });
    const out = await prepareUploadFiles(
      [
        asFile("a.jpg", "image/jpeg"),
        asFile("b.jpg", "image/jpeg"),
        asFile("c.jpg", "image/jpeg"),
        asFile("d.jpg", "image/jpeg"),
        asFile("deck.pdf", "application/pdf"),
      ],
      renderer
    );
    const pdfAsk = asked.find((a) => a.name === "deck.pdf")!;
    check("photos spend the budget the PDF then draws on", pdfAsk.budget === MAX_SCAN_PAGES - 4, String(pdfAsk.budget));
    check("  so the note lands on the cap, never over it", out.files.length === MAX_SCAN_PAGES, String(out.files.length));
  }

  {
    const many = Array.from({ length: MAX_SCAN_PAGES + 3 }, (_, i) => asFile(`p${i}.jpg`, "image/jpeg"));
    const { renderer } = fakeRenderer();
    const out = await prepareUploadFiles(many, renderer);
    check("photos past the cap are dropped, not squeezed in", out.files.length === MAX_SCAN_PAGES, String(out.files.length));
    check("  and counted", out.droppedPages === 3, String(out.droppedPages));
  }

  {
    // Order is reading order. A note whose pages arrive shuffled reads as nonsense, and the
    // text around them has to keep its place too.
    const { renderer } = fakeRenderer({ "mid.pdf": 2 });
    const out = await prepareUploadFiles(
      [asFile("first.md", "text/markdown"), asFile("mid.pdf", "application/pdf"), asFile("last.md", "text/markdown")],
      renderer
    );
    check(
      "order is preserved across kinds",
      out.files.map((f) => f.name).join() === "first.md,mid.pdf-p1.jpg,mid.pdf-p2.jpg,last.md",
      out.files.map((f) => f.name).join()
    );
  }

  {
    // Text, invites and audio are read server-side from their own bytes; re-encoding them
    // would be damage. A note of only text must not even load the renderer.
    const { renderer, asked } = fakeRenderer();
    const original = asFile("notes.md", "text/markdown", "# Standup");
    const out = await prepareUploadFiles([original, asFile("invite.ics", "text/calendar")], renderer);
    check("a note of only text needs no renderer at all", asked.length === 0);
    check("  and its files are passed through untouched", out.files[0] === original);
  }

  {
    const { renderer } = fakeRenderer();
    const out = await prepareUploadFiles([asFile("ok.jpg", "image/jpeg"), asFile("phone.heic", "image/heic")], renderer);
    check("one bad file does not sink the note", out.files.length === 1, String(out.files.length));
    check("  and the bad one is named", out.failures[0]?.name === "phone.heic", JSON.stringify(out.failures));
  }

  {
    // A note where NOTHING could be read must not upload an empty request: that leaves a
    // capture job with no content, which reads on the timeline as a meeting about nothing.
    const { renderer } = fakeRenderer();
    const out = await prepareUploadFiles([asFile("phone.heic", "image/heic")], renderer);
    check("a note that is entirely unreadable prepares nothing", out.files.length === 0);
    check("  rather than looking like a success", out.failures.length === 1);
  }

  {
    // An object URL nobody revokes holds its blob for the life of the document. This path
    // has no thumbnails to show, so every page it mints must be released straight away.
    const { renderer, revoked } = fakeRenderer({ "notes.pdf": 5 });
    await prepareUploadFiles([asFile("notes.pdf", "application/pdf"), asFile("a.jpg", "image/jpeg")], renderer);
    check("every page's object URL is revoked", revoked.length === 6, String(revoked.length));
  }
}

console.log("\nthe same bytes twice stage once");

{
  // Two copies in ONE drop: a folder with `IMG_0412.jpg` and `IMG_0412 (1).jpg` in it.
  const a = file("IMG_0412.jpg", 500, "", "image/jpeg", "same-bytes");
  const b = file("IMG_0412 (1).jpg", 500, "", "image/jpeg", "same-bytes");
  const c = file("other.jpg", 500, "", "image/jpeg");
  const out = stageFiles(emptyState(), [a, b, c]);
  intact("two identical files in one drop stage once", out.state, out.state.files.length === 2);
  check("  the first copy is the one kept", out.state.files[0]!.id === a.id);
  check("  and the fold is reported, not swallowed", out.duplicates === 1, String(out.duplicates));

  // Re-adding: the same bytes dropped again, under a new id and a new name.
  const again = stageFiles(out.state, [file("renamed.jpg", 500, "", "image/jpeg", "same-bytes")]);
  intact("re-adding a file already here stages nothing", again.state, again.state.files.length === 2);
  check("  and says so", again.duplicates === 1, String(again.duplicates));

  // Re-staging the very same StagedFile is a caller repeating itself, not a second copy.
  const repeat = stageFiles(out.state, [a]);
  check("re-staging the same id is not counted as a duplicate", repeat.duplicates === 0, String(repeat.duplicates));

  // A blank hash is "identity unknown", never a match — two unhashable files are two files.
  const blank = stageFiles(emptyState(), [file("x.md", 1, "", "", ""), file("y.md", 1, "", "", "")]);
  intact("two files with no hash are not folded together", blank.state, blank.state.files.length === 2);

  // Dedupe runs before the cap, so a copy never spends one of the slots.
  const full = Array.from({ length: MAX_STAGED_FILES }, (_, i) => file(`n${i}.md`));
  const withCopy = stageFiles(emptyState(), [full[0]!, file("copy.md", 100, "", "", full[0]!.hash), ...full.slice(1)]);
  check(
    "a copy does not push a real file over the cap",
    withCopy.state.files.length === MAX_STAGED_FILES && withCopy.rejected === 0 && withCopy.duplicates === 1,
    `${withCopy.state.files.length} staged, ${withCopy.rejected} rejected, ${withCopy.duplicates} dupes`
  );
}

console.log("\nunticked files stay put and are not read");

{
  let st = stageFiles(emptyState(), [file("a.md", 10), file("b.md", 20), file("c.md", 40), file("d.md", 80)]).state;
  const [a, b, c, d] = st.files.map((f) => f.id) as [string, string, string, string];
  st = moveFiles(addBin(st, "bin1", "Monday"), [a, b], "bin1");
  st = moveFiles(addBin(st, "bin2", "Tuesday"), [c], "bin2");
  // Now: bin1 = a,b · bin2 = c · tray = d.

  const before = planUploads(st, seed);
  check("everything ticked: three notes", before.length === 3, String(before.length));

  st = intact("unticking a file keeps it where it was", setExcluded(st, [b], true), binOf(st, b)?.id === "bin1");
  check("  it reads as excluded", !isIncluded(st, b));
  const minusB = planUploads(st, seed);
  const monday = minusB.find((p) => p.binId === "bin1")!;
  check("  its bin uploads without it", JSON.stringify(monday.fileIds) === JSON.stringify([a]), JSON.stringify(monday.fileIds));
  check("  and is priced without it", monday.bytes === 10 && monday.uploadBytes === 10, `${monday.bytes}/${monday.uploadBytes}`);
  check("  and carries only its hash", JSON.stringify(monday.fileHashes) === JSON.stringify([`hash-${a}`]), JSON.stringify(monday.fileHashes));

  st = intact("a bin whose every file is unticked", setExcluded(st, [c], true), true);
  const noTuesday = planUploads(st, seed);
  check("  produces no note", !noTuesday.some((p) => p.binId === "bin2"), JSON.stringify(noTuesday.map((p) => p.label)));

  st = intact("an unticked loose file", setExcluded(st, [d], true), st.trayIds.includes(d));
  const noLoose = planUploads(st, seed);
  check("  is not uploaded on its own either", !noLoose.some((p) => p.fileIds.includes(d)));
  check("  leaving exactly one note", noLoose.length === 1, String(noLoose.length));

  const retick = setExcluded(st, [b, c, d], false);
  st = intact("ticking them again brings every note back", retick, planUploads(retick, seed).length === 3);

  // Select none / select all are the same helper over every file.
  const none = setExcluded(st, st.files.map((f) => f.id), true);
  st = intact("none ticked", none, planUploads(none, seed).length === 0);
  const all = setExcluded(none, none.files.map((f) => f.id), false);
  st = intact("all ticked again", all, all.excludedIds.length === 0 && planUploads(all, seed).length === 3);

  // Idempotent, ordered, and blind to ids that are not staged.
  const twice = setExcluded(setExcluded(st, [d, a], true), [a], true);
  check("excluding twice lists a file once, in staging order", JSON.stringify(twice.excludedIds) === JSON.stringify([a, d]), JSON.stringify(twice.excludedIds));
  check("an unknown id cannot be excluded", setExcluded(st, ["ghost"], true) === st);

  // Removing an excluded file removes the exclusion too — no phantom left behind.
  const gone = removeFile(setExcluded(st, [a], true), a);
  st = intact("removing an unticked file leaves no exclusion behind", gone, !gone.excludedIds.includes(a));

  // "All one note" names the bin after a file that will actually be read.
  const firstOut = setExcluded(stageFiles(emptyState(), [file("skip-me.md"), file("keep-me.md")]).state, [], true);
  const skipped = setExcluded(firstOut, [firstOut.files[0]!.id], true);
  const combined = combineAll(skipped, ids("bin"), seed);
  intact("combining keeps the unticked file placed", combined, combined.bins[0]!.fileIds.length === 2);
  check("  but names the note after a ticked one", combined.bins[0]!.name === "keep-me", combined.bins[0]!.name);
}

console.log("\nthe invariant catches what it is for");

{
  const st = stageFiles(emptyState(), [file("a.md")]).state;
  const id = st.files[0]!.id;
  check("a healthy state is healthy", invariantBroken(st) === null);
  check("a file in two places is caught", invariantBroken({ ...st, bins: [{ id: "b", name: "x", fileIds: [id], anchorIso: null }] }) !== null);
  check("a file in no place is caught", invariantBroken({ ...st, trayIds: [] }) !== null);
  check("a placed id that was never staged is caught", invariantBroken({ ...st, trayIds: [id, "ghost"] }) !== null);
  check("an excluded id that was never staged is caught", invariantBroken({ ...st, excludedIds: ["ghost"] }) !== null);
  check("a file excluded twice is caught", invariantBroken({ ...st, excludedIds: [id, id] }) !== null);
}

// The hash itself, against the real `crypto.subtle` Node provides — the same API the
// browser uses. Chained into the async tail below with the preparation checks.
async function hashing() {
  console.log("\nhashing file bytes");
  const blob = (text: string) => new Blob([text]);
  const h1 = await hashFileBytes(blob("hello"));
  check("a hash is 64 lowercase hex characters", isFileHash(h1), h1);
  check(
    "  and is the SHA-256 of the bytes",
    h1 === "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    h1
  );
  check("the same bytes hash the same", (await hashFileBytes(blob("hello"))) === h1);
  check("different bytes hash differently", (await hashFileBytes(blob("hello!"))) !== h1);
  const many = await hashFilesSequentially([blob("a"), blob("b"), blob("a")]);
  check("a batch hashes in order", many.length === 3 && many[0] === many[2] && many[0] !== many[1]);
  const broken = await hashFileBytes({ arrayBuffer: () => Promise.reject(new Error("gone")) });
  check("an unreadable file hashes to blank, never throws", broken === "");
}

// Chained rather than top-level `await`: tsx transforms these scripts to CJS, which has
// no top-level await. Everything above this line is synchronous and has already run.
preparation()
  .then(hashing)
  .catch((err: unknown) => {
    console.error(err);
    failures++;
  })
  .finally(() => {
    console.log(failures === 0 ? "\nAll capture bin checks passed." : `\n${failures} check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
  });
