/**
 * A file's identity by content: SHA-256 of its bytes, as lowercase hex.
 *
 * Computed in the browser, on the ORIGINAL bytes the person picked — never on what
 * `prepare-upload.ts` makes of them. Preparation re-encodes photos and rasterizes PDFs, and
 * neither is byte-stable across browsers or releases, so a hash of the prepared bytes would
 * call the same photo two different files the day an encoder changes.
 *
 * What it is for: the notes sorter folds two copies of the same file into one
 * (`stageFiles`), and `capture_jobs.source_file_hashes` remembers what has been read so a
 * file dropped again next week is flagged "Already captured" instead of being read, billed
 * and filed on a timeline twice.
 *
 * `crypto.subtle` only — it exists in every browser this app supports (secure contexts;
 * localhost counts) and in Node 20+, which is what lets the smoke suite call this too.
 */

type HashableFile = { arrayBuffer(): Promise<ArrayBuffer> };

/** Hex SHA-256 of the bytes. Empty string when hashing is unavailable or fails — callers
 *  treat a blank hash as "identity unknown", never as a match. */
export async function hashFileBytes(file: HashableFile): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return "";
    const digest = await subtle.digest("SHA-256", await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return "";
  }
}

/**
 * Hash several files ONE AT A TIME.
 *
 * Sequential on purpose: `arrayBuffer()` materialises the whole file, and a folder of
 * sixty 20MB PDFs hashed with `Promise.all` is 1.2GB held at once in a tab. One at a time
 * holds one file's worth, and SHA-256 is fast enough that the wait is the disk, not this.
 */
export async function hashFilesSequentially(files: readonly HashableFile[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) out.push(await hashFileBytes(f));
  return out;
}

/** A well-formed hash as this module produces it. The server checks what it is sent against this. */
export function isFileHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
