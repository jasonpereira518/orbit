/**
 * Sorting a dropped folder into notes, before any of it is uploaded.
 *
 * The model is a tray and a set of bins. Every file that was dropped starts in the tray at
 * the top of the dialog; a bin is a group of files that will become ONE note — one capture
 * job, one summary, one entry on the timeline. Three photos of the same whiteboard belong in
 * one bin; a folder of twenty standup notes is twenty bins, or twenty files left loose.
 *
 * ## The invariant
 *
 * EVERY FILE IS IN EXACTLY ONE PLACE — the tray, or one bin. Not zero (a file that silently
 * vanished from the dialog is a meeting the person thinks they uploaded and did not), and
 * not two (the same bytes read twice, billed twice, filed on two timelines). Every function
 * here preserves it, and `scripts/smoke-capture-bins.ts` re-checks it after every operation
 * rather than trusting the ones that look obviously safe.
 *
 * ## Leftovers are not an error
 *
 * Files still in the tray when you press Read each become their own note. That is the
 * behaviour this tab already had before bins existed, so doing anything else — refusing to
 * start, or dropping them — would be a regression dressed up as validation. `planUploads`
 * is where that is decided, and it is the only place that gets to decide it.
 *
 * ## Excluded is not removed
 *
 * A file can be staged and still not be read: unticked in the dialog, or already captured
 * once before (see `StagedFile.hash`). It stays in its place — tray or bin — so ticking it
 * again puts it back exactly where it was, and the invariant above still counts it.
 * `planUploads` is what skips it, and a bin whose every file is excluded produces no note
 * at all, for the same reason an empty bin does not.
 *
 * Pure: no React, no DOM, no `File`. The dialog holds the actual `File` objects in a ref and
 * passes ids, because a re-render that retains forty photos is a re-render that costs
 * forty photos.
 */

export type StagedFile = {
  /** Client-side id. Never the name — a folder drop routinely contains two `notes.md`. */
  id: string;
  name: string;
  size: number;
  /**
   * The browser's mime type for the file, carried for the same reason `lastModified` is:
   * pricing a note's upload needs to know a PDF from a photo from a `.md`, and reaching
   * into a side map of `File`s to find out is a staleness bug waiting to happen. May be
   * empty — engines leave it blank for plenty of real files, which is why
   * `classifyScanFile` falls back to the extension.
   */
  type: string;
  /**
   * The file's own mtime, carried here rather than looked up in a side map. Everything that
   * seeds a bin's date reads it while rendering, and a ref read during render is a staleness
   * bug waiting for the render that does not follow the write.
   */
  lastModified: number;
  /**
   * Folder path the file came from, relative to what was dropped ("q1/standups"). Empty for
   * a loose file. Shown in the tile so two files called `notes.md` are tellable apart.
   */
  path: string;
  /**
   * SHA-256 of the file's bytes, lowercase hex, computed in the browser when the file is
   * staged (`hashFileBytes` in `src/lib/capture/file-hash.ts`).
   *
   * Two jobs. It is the dedupe key here — the SAME bytes dropped twice, in one drop or by
   * re-adding, are one file whatever they are called and whatever their mtime says — and it
   * travels with the upload to `capture_jobs.source_file_hashes`, which is how a file read
   * last week is recognised when it comes back this week. Empty when hashing failed; such a
   * file dedupes by id only, which is what staging did before hashes existed.
   */
  hash: string;
};

export type NoteBin = {
  id: string;
  /** Editable, and what the capture is labelled with. Seeded from the first file in it. */
  name: string;
  fileIds: string[];
  /** YYYY-MM-DD, or null when nothing could be read off the files. */
  anchorIso: string | null;
};

export type SorterState = {
  /** Every staged file, in drop order. The one place a file's identity lives. */
  files: StagedFile[];
  bins: NoteBin[];
  /** Ids in no bin yet — the tray. */
  trayIds: string[];
  /**
   * Staged, placed, and NOT to be read. A subset of `files`, orthogonal to placement: an
   * excluded file keeps its spot in the tray or its bin. See "Excluded is not removed".
   */
  excludedIds: string[];
};

/** A folder drop is a folder, not a disk. Past this the dialog would be unusable anyway. */
export const MAX_STAGED_FILES = 60;

export function emptyState(): SorterState {
  return { files: [], bins: [], trayIds: [], excludedIds: [] };
}

/** The bin holding `fileId`, or null when it is in the tray. */
export function binOf(state: SorterState, fileId: string): NoteBin | null {
  return state.bins.find((b) => b.fileIds.includes(fileId)) ?? null;
}

export function fileById(state: SorterState, fileId: string): StagedFile | null {
  return state.files.find((f) => f.id === fileId) ?? null;
}

/**
 * What makes two staged files the same file: their bytes when we know them, their id when
 * we do not. Never the name — a folder drop routinely holds two different `notes.md`, and
 * the same photo exported twice arrives as `IMG_0412.jpg` and `IMG_0412 (1).jpg`.
 */
function identityOf(file: StagedFile): string {
  return file.hash ? `h:${file.hash}` : `id:${file.id}`;
}

/**
 * Add newly dropped files to the tray.
 *
 * Capped rather than rejected: taking the first `MAX_STAGED_FILES` and saying so beats
 * refusing the drop outright, because the person can sort those and drop the rest after.
 *
 * Deduped by CONTENT (see `identityOf`): the same bytes twice — two copies in one drop, or
 * a file dropped again after it is already here — stage once, and `duplicates` says how
 * many were folded so the dialog can say so rather than the count quietly coming up short.
 * Dedupe runs before the cap, so a duplicate never spends one of the `MAX_STAGED_FILES`.
 */
export function stageFiles(
  state: SorterState,
  incoming: readonly StagedFile[]
): { state: SorterState; rejected: number; duplicates: number } {
  const seen = new Set(state.files.map(identityOf));
  const knownIds = new Set(state.files.map((f) => f.id));
  const fresh: StagedFile[] = [];
  let duplicates = 0;
  for (const f of incoming) {
    const key = identityOf(f);
    if (seen.has(key)) {
      // The same ID again is a caller re-staging what it already staged, not a second copy
      // the person dropped — not worth telling anyone about.
      if (!knownIds.has(f.id)) duplicates++;
      continue;
    }
    seen.add(key);
    knownIds.add(f.id);
    fresh.push(f);
  }
  const room = Math.max(0, MAX_STAGED_FILES - state.files.length);
  const taken = fresh.slice(0, room);
  return {
    state: {
      ...state,
      files: [...state.files, ...taken],
      trayIds: [...state.trayIds, ...taken.map((f) => f.id)],
    },
    rejected: fresh.length - taken.length,
    duplicates,
  };
}

/** Whether `fileId` will be read when Read is pressed. */
export function isIncluded(state: SorterState, fileId: string): boolean {
  return !state.excludedIds.includes(fileId);
}

/**
 * Tick or untick files for reading. Ids that are not staged are ignored — an exclusion for
 * a file that is not here would be a phantom the invariant has to explain.
 *
 * Placement is untouched: see "Excluded is not removed" in the header.
 */
export function setExcluded(
  state: SorterState,
  fileIds: readonly string[],
  excluded: boolean
): SorterState {
  const staged = new Set(state.files.map((f) => f.id));
  const targets = new Set(fileIds.filter((id) => staged.has(id)));
  if (!targets.size) return state;
  const current = new Set(state.excludedIds);
  for (const id of targets) {
    if (excluded) current.add(id);
    else current.delete(id);
  }
  // Kept in staging order rather than click order, so two routes to the same set are equal.
  return { ...state, excludedIds: state.files.map((f) => f.id).filter((id) => current.has(id)) };
}

/** Remove a file entirely — from the tray or from whichever bin holds it. */
export function removeFile(state: SorterState, fileId: string): SorterState {
  return {
    files: state.files.filter((f) => f.id !== fileId),
    trayIds: state.trayIds.filter((id) => id !== fileId),
    excludedIds: state.excludedIds.filter((id) => id !== fileId),
    // An emptied bin is kept, not swept: it may be the one the person is about to drag the
    // next file into, and having it disappear under the cursor is its own small betrayal.
    bins: state.bins.map((b) => ({ ...b, fileIds: b.fileIds.filter((id) => id !== fileId) })),
  };
}

/**
 * Move files to a bin, or back to the tray with `null`.
 *
 * Detaches from wherever each one currently is first, which is what makes the invariant hold
 * without every caller having to know where a file came from — the dialog drags from a bin
 * to a bin as often as from the tray.
 */
export function moveFiles(
  state: SorterState,
  fileIds: readonly string[],
  toBinId: string | null
): SorterState {
  const moving = state.files.filter((f) => fileIds.includes(f.id)).map((f) => f.id);
  if (!moving.length) return state;
  const movingSet = new Set(moving);

  const detachedBins = state.bins.map((b) => ({
    ...b,
    fileIds: b.fileIds.filter((id) => !movingSet.has(id)),
  }));
  const detachedTray = state.trayIds.filter((id) => !movingSet.has(id));

  if (toBinId === null) {
    return { ...state, bins: detachedBins, trayIds: [...detachedTray, ...moving] };
  }
  if (!detachedBins.some((b) => b.id === toBinId)) {
    // A drop onto a bin that has since been removed. Nothing is lost; the files stay put.
    return state;
  }
  return {
    ...state,
    trayIds: detachedTray,
    bins: detachedBins.map((b) =>
      b.id === toBinId ? { ...b, fileIds: [...b.fileIds, ...moving] } : b
    ),
  };
}

/** A new, empty bin at the end. `id` is supplied so the caller owns id generation. */
export function addBin(state: SorterState, id: string, name = "Untitled note"): SorterState {
  return { ...state, bins: [...state.bins, { id, name, fileIds: [], anchorIso: null }] };
}

/** Remove a bin. Its files return to the tray rather than being deleted. */
export function removeBin(state: SorterState, binId: string): SorterState {
  const bin = state.bins.find((b) => b.id === binId);
  if (!bin) return state;
  return {
    ...state,
    bins: state.bins.filter((b) => b.id !== binId),
    trayIds: [...state.trayIds, ...bin.fileIds],
  };
}

export function renameBin(state: SorterState, binId: string, name: string): SorterState {
  return {
    ...state,
    bins: state.bins.map((b) => (b.id === binId ? { ...b, name } : b)),
  };
}

export function setBinAnchor(
  state: SorterState,
  binId: string,
  anchorIso: string | null
): SorterState {
  return {
    ...state,
    bins: state.bins.map((b) => (b.id === binId ? { ...b, anchorIso } : b)),
  };
}

/**
 * Give every file still in the tray its own bin.
 *
 * Deliberately the TRAY and not everything: the button sits over the tray, and a person who
 * has spent a minute grouping photos should not lose that to a mis-click on a control they
 * read as "sort out the rest". Since everything starts in the tray, the two readings are the
 * same at the moment this is most likely to be pressed.
 *
 * `mintId` and `nameFor` come from the caller so this stays pure — ids and the date-derived
 * label both belong to the browser.
 */
export function separateTray(
  state: SorterState,
  mintId: () => string,
  seed: (file: StagedFile) => { name: string; anchorIso: string | null }
): SorterState {
  if (!state.trayIds.length) return state;
  const added: NoteBin[] = [];
  for (const id of state.trayIds) {
    const file = fileById(state, id);
    if (!file) continue;
    const { name, anchorIso } = seed(file);
    added.push({ id: mintId(), name, fileIds: [id], anchorIso });
  }
  return { ...state, bins: [...state.bins, ...added], trayIds: [] };
}

/**
 * Everything, tray and bins alike, into one bin. The other half of `separateTray`.
 *
 * Excluded files move too — placement and inclusion are separate questions — but the bin is
 * named after the first file that will actually be READ, so a note is never titled after
 * the one photo in it that was left out.
 */
export function combineAll(
  state: SorterState,
  mintId: () => string,
  seed: (file: StagedFile) => { name: string; anchorIso: string | null }
): SorterState {
  if (!state.files.length) return state;
  const first = state.files.find((f) => isIncluded(state, f.id)) ?? state.files[0]!;
  const { name, anchorIso } = seed(first);
  return {
    ...state,
    trayIds: [],
    bins: [{ id: mintId(), name, fileIds: state.files.map((f) => f.id), anchorIso }],
  };
}

export type PlannedUpload = {
  /** The bin this came from, or null for a file left loose in the tray. */
  binId: string | null;
  label: string;
  fileIds: string[];
  anchorIso: string | null;
  /** What the person picked, added up. The honest number to show beside a list of files. */
  bytes: number;
  /**
   * The `StagedFile.hash` of every file in `fileIds`, in the same order, blanks dropped.
   * Sent with the upload and stored on the job, so this note's files are recognised if they
   * are ever dropped again.
   */
  fileHashes: string[];
  /**
   * What the request will weigh once the files have been prepared — the number the size cap
   * is checked against, and usually not the one above.
   *
   * They differ because preparation is not a copy: photos are re-encoded DOWN (five 5MB
   * whiteboard shots become about 6MB) and a PDF is rasterized UP (2MB becomes a dozen
   * pages). Checking `bytes` would refuse the first and wave through the second, so this
   * exists to be checked while `bytes` stays what a file manager would report. See
   * `estimatePreparedBytes` in `src/lib/capture/prepare-upload.ts` for how it is priced.
   */
  uploadBytes: number;
};

/**
 * How much one note will weigh once prepared. Injected rather than imported so this module
 * stays free of mime-type knowledge — and so a caller with no preparation step at all (a
 * test, say) gets the sum of the sizes, which is what it would have had before.
 */
export type WeighUpload = (files: readonly StagedFile[]) => number;

const sumSizes: WeighUpload = (files) => files.reduce((n, f) => n + f.size, 0);

/**
 * What pressing Read will actually upload: one entry per bin, then one per leftover file.
 *
 * Only INCLUDED files count. Empty bins produce nothing — an empty bin is a bin somebody
 * made and did not use, not a note about nothing — and neither does a bin whose every file
 * is excluded, which is the same bin as far as the upload is concerned.
 */
export function planUploads(
  state: SorterState,
  seed: (file: StagedFile) => { name: string; anchorIso: string | null },
  weigh: WeighUpload = sumSizes
): PlannedUpload[] {
  const excluded = new Set(state.excludedIds);
  const filesOf = (ids: readonly string[]) =>
    ids
      .filter((id) => !excluded.has(id))
      .map((id) => fileById(state, id))
      .filter((f): f is StagedFile => Boolean(f));
  const hashesOf = (files: readonly StagedFile[]) => files.map((f) => f.hash).filter(Boolean);

  const fromBins = state.bins.flatMap<PlannedUpload>((b) => {
    const files = filesOf(b.fileIds);
    if (!files.length) return [];
    return [
      {
        binId: b.id,
        label: b.name.trim() || files[0]!.name || "Untitled note",
        fileIds: files.map((f) => f.id),
        anchorIso: b.anchorIso,
        bytes: files.reduce((n, f) => n + f.size, 0),
        fileHashes: hashesOf(files),
        uploadBytes: weigh(files),
      },
    ];
  });

  const loose = state.trayIds.flatMap<PlannedUpload>((id) => {
    if (excluded.has(id)) return [];
    const file = fileById(state, id);
    if (!file) return [];
    const { name, anchorIso } = seed(file);
    return [
      {
        binId: null,
        label: name,
        fileIds: [id],
        anchorIso,
        bytes: file.size,
        fileHashes: hashesOf([file]),
        uploadBytes: weigh([file]),
      },
    ];
  });

  return [...fromBins, ...loose];
}

/**
 * Uploads that will not fit in one request.
 *
 * Checked PER UPLOAD rather than per file, which is the whole reason it has to be re-done
 * for bins: the cap is on the request, and four photos that each fit can add up to one that
 * does not. Reported rather than auto-split — splitting a bin would silently make two
 * meetings out of the one the person just said was one.
 *
 * Against `uploadBytes`, never `bytes`: the cap applies to the request that is actually
 * sent, and preparation moves that number in both directions. See `PlannedUpload`.
 */
export function oversizedUploads(
  uploads: readonly PlannedUpload[],
  maxBytes: number
): PlannedUpload[] {
  return uploads.filter((u) => u.uploadBytes > maxBytes);
}

/**
 * The invariant, as a function.
 *
 * Exported so the smoke suite can assert it after every operation instead of after the ones
 * that look risky — the operations that look safe are the ones that quietly stop being safe.
 */
export function invariantBroken(state: SorterState): string | null {
  const placed = [...state.trayIds, ...state.bins.flatMap((b) => b.fileIds)];
  const seen = new Set<string>();
  for (const id of placed) {
    if (seen.has(id)) return `file ${id} is in two places`;
    seen.add(id);
  }
  for (const f of state.files) {
    if (!seen.has(f.id)) return `file ${f.id} is in no place at all`;
  }
  for (const id of placed) {
    if (!state.files.some((f) => f.id === id)) return `id ${id} is placed but not staged`;
  }
  const excluded = new Set<string>();
  for (const id of state.excludedIds) {
    if (excluded.has(id)) return `file ${id} is excluded twice`;
    excluded.add(id);
    if (!state.files.some((f) => f.id === id)) return `id ${id} is excluded but not staged`;
  }
  return null;
}
