/**
 * Turn the files in ONE note into the files that can actually be uploaded.
 *
 * THE BUG THIS EXISTS FOR: the Notes library offered PDFs (`CAPTURE_FILE_ACCEPT` lists
 * `application/pdf`) and then sent them up untouched. Nothing on the server reads a PDF —
 * `normalizeCaptureInput` classifies by mime type, `application/pdf` matches neither
 * `isImage` nor `isAudio` nor any text branch, and the file falls through to
 * `throw new Error("Unsupported file type: notes.pdf")`. A folder containing a PDF failed
 * that bin outright, with an error naming a format the picker had just invited.
 *
 * Messy Notes never had the bug because it goes through `sortAndNormalizeScanFiles`, which
 * rasterizes first. The fan-out path grew its own uploader and did not. This is the shared
 * answer: one function, called once per note, that both paths can agree on.
 *
 * ## Why per note, and not once per drop
 *
 * The page budget is `MAX_SCAN_PAGES` per REQUEST, and one note is one request. Preparing
 * per note is therefore not just tidier — it is the whole fix for the other half of the
 * complaint, that a drop of three PDFs read the first few pages of the first one and
 * nothing at all of the other two. Sorted into three notes, each gets its own twelve.
 *
 * ## What happens to each kind
 *
 *   PDF     rasterized to JPEG pages, because no provider in this codebase is sent PDFs —
 *           see `rasterizePdf`, which explains why that is one code path instead of three.
 *   image   decoded and re-encoded, which is what makes an iPhone HEIC readable by OpenAI
 *           and Anthropic and takes an 8MP photo from ~8MB to a few hundred KB.
 *   rest    passed through untouched: `.txt`, `.md`, `.ics`, `.eml` and audio are all read
 *           server-side from their original bytes, and re-encoding them would be damage.
 *
 * Nothing here throws for one bad file. A note holding a good photo and an unreadable one
 * uploads the good one and reports the other, for the same reason `transcribeImagePages`
 * tolerates a failed page: seven of eight pages is worth far more than an error.
 */
import {
  MAX_SCAN_PAGES,
  SCAN_PAGE_BUDGET_BYTES,
  SCAN_TARGET_BYTES,
  ScanError,
  classifyScanFile,
} from "@/lib/scan-image";
import type { ScanPage } from "@/lib/scan-capture";

export type PrepareFailure = {
  /** The file as the person named it, so the message can point at something they can see. */
  name: string;
  message: string;
};

export type PreparedUpload = {
  /** Exactly what should go in the request. Never contains a PDF. */
  files: File[];
  /**
   * Pages past the budget.
   *
   * READ THIS AS A FLAG, NOT A TOTAL. A visual file skipped whole — the second PDF in a
   * note whose budget the first one spent — counts once, because its page count is not
   * knowable without opening it, and opening it is the expense being avoided. So
   * `> 0` means "this note was truncated" exactly, while the number itself is a floor.
   * `prepareNotice` therefore reports the CAP, which is always true, rather than the count.
   */
  droppedPages: number;
  /** Files that could not be read at all. The rest still went. */
  failures: PrepareFailure[];
};

/** Just enough of a `File` to price it, so the estimate is testable without the DOM. */
export type WeighableFile = { name: string; type: string; size: number };

/**
 * The browser-only half, named so it can be swapped.
 *
 * The budget accounting below is the part worth testing — an off-by-one there does not
 * throw, it silently returns a note eleven pages long and nobody finds out until the
 * meeting they needed is the one that got cut. But it cannot run under node, because
 * rasterizing needs a canvas. So it is injected, the same way `readDroppedEntries` takes
 * structural entries and `separateTray` takes a `mintId`: the arithmetic becomes reachable
 * with plain data, and the default is still the real renderer.
 */
export type PageRenderer = {
  rasterizePdf: (file: File, budget: number) => Promise<{ pages: ScanPage[]; dropped: number }>;
  normalizeImageFile: (file: File) => Promise<ScanPage>;
  releaseScanPage: (page: ScanPage) => void;
};

/**
 * What one note will weigh once it has been prepared — the number the size cap should be
 * checked against, and NOT the number to show a person next to a filename.
 *
 * A file's size on disk is a bad proxy in both directions, and both are real:
 *
 *   TOO BIG.   Five 5MB phone photos of one whiteboard total 25MB and would be refused,
 *              though they re-encode to about 6MB. That is precisely the case the sorting
 *              dialog exists to encourage — "photos of one whiteboard together" — so
 *              blocking it would be the feature refusing its own example.
 *   TOO SMALL. A 2MB PDF becomes twelve JPEG pages that weigh far more than 2MB, and would
 *              be waved through to fail at the server with a size error about bytes the
 *              person never chose.
 *
 * So the visual half is priced at its BOUND rather than its input: at most
 * `SCAN_PAGE_BUDGET_BYTES`, and for images alone at most one target per image, since an
 * image can only ever become one page. Deliberately an over-estimate — a note that is
 * waved through and then refused costs the person a failed upload, while one that is
 * queried early costs them a drag.
 */
export function estimatePreparedBytes(files: readonly WeighableFile[]): number {
  let passthrough = 0;
  let images = 0;
  let hasPdf = false;

  for (const file of files) {
    const kind = classifyScanFile(file.name, file.type);
    if (kind === "pdf") hasPdf = true;
    else if (kind === "image") images += 1;
    else passthrough += file.size;
  }

  // An image is one page at most, so a handful of photos is priced honestly rather than at
  // the whole budget. A PDF's page count is unknowable without parsing it, so any PDF in
  // the note means assuming it fills whatever the images leave.
  const visual = hasPdf
    ? SCAN_PAGE_BUDGET_BYTES
    : Math.min(images, MAX_SCAN_PAGES) * SCAN_TARGET_BYTES;
  return passthrough + visual;
}

/** A page comes back as base64 because that is what the scan UI needs. Requests need bytes. */
function base64ToFile(base64: string, filename: string, mimeType: string): File {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], filename, { type: mimeType });
}

function messageFor(file: File, err: unknown): string {
  if (err instanceof ScanError && err.reason === "heic-undecodable") {
    // Only Safari decodes HEIC. Naming the fix matters: it is one the person can act on.
    return `${file.name} is an iPhone photo this browser can’t open — export it as JPEG, or send it with “Use your phone”`;
  }
  if (err instanceof ScanError && err.reason === "empty-pdf") {
    return `${file.name} has no pages in it`;
  }
  return `Couldn’t read ${file.name}`;
}

/**
 * Prepare one note's files.
 *
 * `pdfjs` and the canvas encoder are behind a dynamic import, so neither rides the app
 * shell: a person who never drops a PDF never downloads the renderer. It is imported once
 * per note rather than hoisted because the module cache makes every call after the first
 * free, and hoisting it would pull the bundle in at module scope — which is the thing the
 * dynamic import is for.
 */
export async function prepareUploadFiles(
  files: readonly File[],
  renderer?: PageRenderer
): Promise<PreparedUpload> {
  const visual = files.filter((f) => classifyScanFile(f.name, f.type) !== "unsupported");
  // Nothing visual: no renderer, no re-encode, and — importantly — no change at all to the
  // path a folder of plain text notes already took.
  if (!visual.length) return { files: [...files], droppedPages: 0, failures: [] };

  const { normalizeImageFile, rasterizePdf, releaseScanPage } =
    renderer ?? (await import("@/lib/scan-capture"));

  const out: File[] = [];
  const failures: PrepareFailure[] = [];
  let droppedPages = 0;
  let budget = MAX_SCAN_PAGES;

  for (const file of files) {
    const kind = classifyScanFile(file.name, file.type);
    if (kind === "unsupported") {
      out.push(file);
      continue;
    }
    if (budget <= 0) {
      // Everything visual past the budget is a dropped page, whether it is a photo or a
      // whole PDF we never opened. Counted, so the count is what the person is told.
      droppedPages += 1;
      continue;
    }

    try {
      if (kind === "pdf") {
        const rendered = await rasterizePdf(file, budget);
        droppedPages += rendered.dropped;
        for (const page of rendered.pages) {
          out.push(base64ToFile(page.base64, page.filename, page.mimeType));
          // The preview URL is for the scan UI's thumbnails, which this path does not have.
          // An object URL nobody revokes holds its blob for the life of the document.
          releaseScanPage(page);
        }
        budget -= rendered.pages.length;
      } else {
        const page = await normalizeImageFile(file);
        out.push(base64ToFile(page.base64, page.filename, page.mimeType));
        releaseScanPage(page);
        budget -= 1;
      }
    } catch (err) {
      failures.push({ name: file.name, message: messageFor(file, err) });
    }
  }

  return { files: out, droppedPages, failures };
}

/**
 * The one line to show for a prepared note, or null when there is nothing worth saying.
 *
 * Truncation has to be said out loud: a note silently missing its last eighteen pages is
 * indistinguishable, later, from a meeting where nothing was decided.
 */
export function prepareNotice(prepared: PreparedUpload): string | null {
  const parts: string[] = [];
  if (prepared.droppedPages > 0) {
    parts.push(
      `only the first ${MAX_SCAN_PAGES} pages were read — put the rest in their own note`
    );
  }
  if (prepared.failures.length === 1) parts.push(prepared.failures[0]!.message);
  else if (prepared.failures.length > 1) {
    parts.push(`${prepared.failures.length} files couldn’t be read`);
  }
  return parts.length ? parts.join(" · ") : null;
}
