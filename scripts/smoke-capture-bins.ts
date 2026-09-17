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
 * Run: npx tsx scripts/smoke-capture-bins.ts
 */
import {
  MAX_STAGED_FILES,
  addBin,
  binOf,
  combineAll,
  emptyState,
  invariantBroken,
  moveFiles,
  oversizedUploads,
  planUploads,
  removeBin,
  removeFile,
  renameBin,
  separateTray,
  setBinAnchor,
  stageFiles,
  type SorterState,
  type StagedFile,
} from "../src/lib/capture/bins";
import { estimatePreparedBytes, prepareNotice } from "../src/lib/capture/prepare-upload";
import { CAPTURE_MAX_UPLOAD_BYTES } from "../src/lib/capture-limits";
import { MAX_SCAN_PAGES, SCAN_TARGET_BYTES } from "../src/lib/scan-image";

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
const file = (name: string, size = 100, path = "", type = ""): StagedFile => ({
  id: `f${++n}`,
  name,
  size,
  type,
  lastModified: 0,
  path,
});

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

console.log("\nthe invariant catches what it is for");

{
  const st = stageFiles(emptyState(), [file("a.md")]).state;
  const id = st.files[0]!.id;
  check("a healthy state is healthy", invariantBroken(st) === null);
  check("a file in two places is caught", invariantBroken({ ...st, bins: [{ id: "b", name: "x", fileIds: [id], anchorIso: null }] }) !== null);
  check("a file in no place is caught", invariantBroken({ ...st, trayIds: [] }) !== null);
  check("a placed id that was never staged is caught", invariantBroken({ ...st, trayIds: [id, "ghost"] }) !== null);
}

console.log(failures === 0 ? "\nAll capture bin checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
