/**
 * Pins the arithmetic and the file-type judgements behind note scanning.
 *
 * WHAT THIS GUARDS. Scanning re-encodes every page to JPEG before upload, and that one
 * step is load-bearing for three separate things: it is the only reason an iPhone HEIC
 * ever reaches OpenAI or Anthropic in a format they can read, it is what keeps a full
 * 8-page scan inside the server-action body limit, and it is what stops a 12MP photo from
 * being uploaded whole over phone data. If the ladder stops shrinking, or the classifier
 * stops recognising a `.HEIC` with an empty mime type, all three regress quietly — the
 * upload still succeeds and the model just returns worse text.
 *
 * Pure: no network, no database, no DOM. Run: npx tsx scripts/smoke-scan-image.ts
 */
import {
  MAX_SCAN_PAGES,
  SCAN_EDGE_LADDER,
  SCAN_OUTPUT_MIME,
  SCAN_QUALITY_LADDER,
  SCAN_TARGET_BYTES,
  capScanPages,
  classifyScanFile,
  estimateBase64Length,
  estimateDecodedBytes,
  fitEdge,
  isHeicSource,
  pageUnreadableMarker,
  scanEncodeAttempts,
  scanSourceLabel,
} from "../src/lib/scan-image";
import { CAPTURE_MAX_UPLOAD_BYTES } from "../src/lib/capture-limits";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

function main() {
  console.log("Classifying what the person picked...");
  check("a normal JPEG is an image", classifyScanFile("notes.jpg", "image/jpeg") === "image");
  check("a PDF is a pdf", classifyScanFile("deck.pdf", "application/pdf") === "pdf");
  // Android pickers routinely supply an empty mime type and nothing but the name.
  check("an empty mime type falls back to the extension",
    classifyScanFile("IMG_0421.HEIC", "") === "image");
  check("a PDF with no mime type is still a pdf", classifyScanFile("scan.PDF", "") === "pdf");
  check("a spreadsheet is unsupported", classifyScanFile("people.csv", "text/csv") === "unsupported");
  check("an audio file is not mistaken for a page",
    classifyScanFile("memo.m4a", "audio/mp4") === "unsupported");

  console.log("\nHEIC is detected by either signal, because browsers differ, not files...");
  check("by mime", isHeicSource("x", "image/heic"));
  check("by uppercase extension", isHeicSource("IMG_1.HEIC", ""));
  check("heif counts too", isHeicSource("x.heif", ""));
  check("a JPEG is not HEIC", !isHeicSource("notes.jpg", "image/jpeg"));

  console.log("\nThe downscale ladder...");
  const a4 = fitEdge(4032, 3024, 2000);
  check("a 12MP phone photo is reduced to the top of the ladder",
    a4.width === 2000 && a4.height === 1500, JSON.stringify(a4));
  check("aspect ratio is preserved", Math.abs(a4.width / a4.height - 4032 / 3024) < 0.01);
  const portrait = fitEdge(3024, 4032, 2000);
  check("portrait shrinks by its long edge too",
    portrait.height === 2000 && portrait.width === 1500, JSON.stringify(portrait));
  const small = fitEdge(800, 600, 2000);
  check("a small image is never scaled UP", small.width === 800 && small.height === 600);
  const degenerate = fitEdge(0, 0, 2000);
  check("a zero-dimension source still yields a drawable canvas",
    degenerate.width >= 1 && degenerate.height >= 1);

  console.log("\nEncode attempt order: quality first, then resolution...");
  const attempts = scanEncodeAttempts();
  check("every combination is covered",
    attempts.length === SCAN_EDGE_LADDER.length * SCAN_QUALITY_LADDER.length,
    String(attempts.length));
  check("the first attempt is the best one",
    attempts[0]!.edge === SCAN_EDGE_LADDER[0] && attempts[0]!.quality === SCAN_QUALITY_LADDER[0]);
  // Handwriting survives JPEG artefacts better than it survives being resampled away.
  check("quality drops before the edge does",
    attempts[1]!.edge === attempts[0]!.edge && attempts[1]!.quality < attempts[0]!.quality);
  check("the ladder only ever gets smaller",
    attempts.every((a, i) => i === 0 || a.edge <= attempts[i - 1]!.edge));
  check("output is always JPEG", SCAN_OUTPUT_MIME === "image/jpeg");

  console.log("\nA full scan fits inside the upload budget...");
  const worstCase = SCAN_TARGET_BYTES * MAX_SCAN_PAGES;
  check("8 pages at the byte target stay under the user-facing file budget",
    worstCase < CAPTURE_MAX_UPLOAD_BYTES,
    `${worstCase} vs ${CAPTURE_MAX_UPLOAD_BYTES}`);
  check("...and so does their base64 encoding, which is what actually travels",
    estimateBase64Length(worstCase) < CAPTURE_MAX_UPLOAD_BYTES * 1.34 + 1,
    String(estimateBase64Length(worstCase)));
  check("the decode estimate round-trips within a rounding group",
    Math.abs(estimateDecodedBytes(estimateBase64Length(worstCase)) - worstCase) < 4);

  console.log("\nPage caps...");
  check("a 3-page scan keeps all 3", capScanPages(3).kept === 3 && capScanPages(3).dropped === 0);
  check("a 20-page PDF is truncated, and says by how much",
    capScanPages(20).kept === MAX_SCAN_PAGES && capScanPages(20).dropped === 20 - MAX_SCAN_PAGES);
  check("zero pages is not negative", capScanPages(0).kept === 0 && capScanPages(0).dropped === 0);

  console.log("\nPartial success is reported honestly...");
  check("a clean run reads as a plain count", scanSourceLabel(8, 8) === "photos:8");
  // The failure this exists for: claiming 8 pages when one came back empty.
  check("a partial run shows the shortfall", scanSourceLabel(7, 8) === "photos:7/8");
  check("an unreadable page leaves a visible gap in the corpus",
    pageUnreadableMarker(3) === "[Page 3 could not be read]");

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll scan-image checks passed.");
  process.exit(0);
}

main();
