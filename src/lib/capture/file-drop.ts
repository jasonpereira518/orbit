/**
 * Turning a drop into a list of files, including when what was dropped is a folder.
 *
 * `DataTransfer.files` does NOT contain the contents of a dropped directory — it contains
 * the directory, as a zero-byte entry that reads as an empty file. That is why dropping a
 * folder on the old zone appeared to do nothing at all. The contents only come out through
 * `webkitGetAsEntry()` and the directory reader beneath it, which is what this walks.
 *
 * ## The truncation nobody notices
 *
 * `FileSystemDirectoryReader.readEntries` returns a BATCH, not the directory: Chrome caps it
 * at 100 entries and signals the end with an empty array. Calling it once and using the
 * result is the bug this module exists to not have — a folder of 140 meeting notes would
 * silently become 100, and the missing 40 look exactly like meetings that never happened.
 * So it loops until empty, and bounds the loop so a pathological tree cannot hang the tab.
 *
 * ## Injectable by construction
 *
 * Every browser type this needs is re-declared structurally, so
 * `scripts/smoke-capture-file-drop.ts` can drive the walk with plain objects — including the
 * batching, which is otherwise only reachable with a 100-file fixture folder.
 */

/** The parts of `FileSystemEntry` this uses. Structural so a test can stand one up. */
export type DropEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (file: File) => void, fail?: (err: unknown) => void) => void;
  createReader?: () => {
    readEntries: (
      ok: (entries: DropEntry[]) => void,
      fail?: (err: unknown) => void,
    ) => void;
  };
};

export type DroppedFile = {
  file: File;
  /** Folder path relative to what was dropped, "" at the top level. */
  path: string;
};

/** Depth past which a tree is somebody's home directory, not a folder of notes. */
export const MAX_DROP_DEPTH = 8;
/** Total files read out of one drop. Matches the sorter's own ceiling. */
export const MAX_DROP_FILES = 60;
/**
 * Batches per directory. 100 entries each, so this is 20,000 files in one folder — far past
 * anything real, and a bound rather than a promise: the point is that the loop terminates.
 */
const MAX_BATCHES_PER_DIR = 200;

/**
 * Noise every folder on every platform contains, and nobody means to upload.
 *
 * Dotfiles go as a class: `.DS_Store`, `.git`, and the editor droppings that would otherwise
 * each become a note titled "swp".
 */
export function isIgnorableFile(name: string): boolean {
  if (name.startsWith(".")) return true;
  return /^(thumbs\.db|desktop\.ini|icon\r?)$/i.test(name);
}

function entryFile(entry: DropEntry): Promise<File | null> {
  if (!entry.file) return Promise.resolve(null);
  return new Promise((resolve) => {
    // Never rejects: one unreadable file in a folder of forty must not take the drop with
    // it, and "this one file could not be read" is not something the person can act on.
    entry.file!(
      (file) => resolve(file),
      () => resolve(null),
    );
  });
}

function readBatch(reader: {
  readEntries: (
    ok: (entries: DropEntry[]) => void,
    fail?: (err: unknown) => void,
  ) => void;
}): Promise<DropEntry[]> {
  return new Promise((resolve) => {
    reader.readEntries(
      (entries) => resolve(entries),
      () => resolve([]),
    );
  });
}

/**
 * How much of a tree to read.
 *
 * Defaults are the capture tray's, which is what every existing caller wants. Imports pass a
 * larger file cap: an unzipped LinkedIn archive folder holds dozens of CSVs and sits close
 * enough to 60 that the default would silently drop the ones that matter.
 */
export type DropLimits = {
  maxFiles: number;
  maxDepth: number;
};

export const DEFAULT_DROP_LIMITS: DropLimits = {
  maxFiles: MAX_DROP_FILES,
  maxDepth: MAX_DROP_DEPTH,
};

/**
 * Walk one entry, depth-first, appending into `out`.
 *
 * Breadth-first would have been fine too; depth-first is chosen because it keeps a folder's
 * files adjacent in the result, and adjacency is what makes the tray readable when the drop
 * spans several subfolders.
 */
async function walk(
  entry: DropEntry,
  path: string,
  depth: number,
  out: DroppedFile[],
  limits: DropLimits,
): Promise<void> {
  if (out.length >= limits.maxFiles) return;

  if (entry.isFile) {
    if (isIgnorableFile(entry.name)) return;
    const file = await entryFile(entry);
    if (file) out.push({ file, path });
    return;
  }

  if (!entry.isDirectory || depth >= limits.maxDepth) return;
  const reader = entry.createReader?.();
  if (!reader) return;

  const childPath = path ? `${path}/${entry.name}` : entry.name;
  for (let batch = 0; batch < MAX_BATCHES_PER_DIR; batch++) {
    const entries = await readBatch(reader);
    // The empty batch IS the end-of-directory signal. There is no other one.
    if (!entries.length) return;
    for (const child of entries) {
      if (out.length >= limits.maxFiles) return;
      await walk(child, childPath, depth + 1, out, limits);
    }
  }
}

export type DropReadResult = {
  files: DroppedFile[];
  /** True when the cap was hit and there was more on disk. */
  truncated: boolean;
};

/**
 * Read everything out of a drop.
 *
 * `items` is preferred because it is the only thing that can see inside a folder; `fallback`
 * is `DataTransfer.files`, used when the browser gave us no entries at all. Both paths drop
 * the same noise, so a `.DS_Store` cannot become a note either way.
 */
export async function readDroppedEntries(
  items: readonly DropEntry[],
  fallback: readonly File[] = [],
  limits: DropLimits = DEFAULT_DROP_LIMITS,
): Promise<DropReadResult> {
  const out: DroppedFile[] = [];
  for (const entry of items) {
    if (out.length >= limits.maxFiles) break;
    await walk(entry, "", 0, out, limits);
  }

  // Only when the browser gave us NO entries at all — not merely when the entries yielded
  // nothing. A dropped empty folder produces zero files but appears in `DataTransfer.files`
  // as a zero-byte entry, so falling back on an empty RESULT would stage the folder itself
  // as a note called "q1".
  if (!items.length && fallback.length) {
    for (const file of fallback) {
      if (out.length >= limits.maxFiles) break;
      if (isIgnorableFile(file.name)) continue;
      out.push({ file, path: "" });
    }
    return { files: out, truncated: fallback.length > out.length };
  }

  return { files: out, truncated: out.length >= limits.maxFiles };
}

/**
 * Pull the entries out of a real `DataTransfer`.
 *
 * Split from the walk so the walk stays testable. `webkitGetAsEntry` is the standard name in
 * every engine that supports this at all, despite the prefix.
 */
export function entriesFromDataTransfer(dt: DataTransfer): DropEntry[] {
  const out: DropEntry[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.() as DropEntry | null;
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * The folder path a `<input webkitdirectory>` reports, minus the file itself.
 *
 * The picker gives `webkitRelativePath` as "folder/sub/notes.md"; the tray wants "folder/sub"
 * so it can show where a file came from without repeating its name.
 */
export function pathFromRelative(
  relativePath: string | undefined,
  name: string,
): string {
  if (!relativePath) return "";
  const trimmed = relativePath.endsWith(`/${name}`)
    ? relativePath.slice(0, -1 * (name.length + 1))
    : relativePath;
  return trimmed === name ? "" : trimmed;
}
