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
};

/** A folder drop is a folder, not a disk. Past this the dialog would be unusable anyway. */
export const MAX_STAGED_FILES = 60;

export function emptyState(): SorterState {
  return { files: [], bins: [], trayIds: [] };
}

/** The bin holding `fileId`, or null when it is in the tray. */
export function binOf(state: SorterState, fileId: string): NoteBin | null {
  return state.bins.find((b) => b.fileIds.includes(fileId)) ?? null;
}

export function fileById(state: SorterState, fileId: string): StagedFile | null {
  return state.files.find((f) => f.id === fileId) ?? null;
}

/**
 * Add newly dropped files to the tray.
 *
 * Capped rather than rejected: taking the first `MAX_STAGED_FILES` and saying so beats
 * refusing the drop outright, because the person can sort those and drop the rest after.
 * Ids already staged are ignored, so dropping the same folder twice does not double it.
 */
export function stageFiles(
  state: SorterState,
  incoming: readonly StagedFile[]
): { state: SorterState; rejected: number } {
  const known = new Set(state.files.map((f) => f.id));
  const room = Math.max(0, MAX_STAGED_FILES - state.files.length);
  const fresh = incoming.filter((f) => !known.has(f.id));
  const taken = fresh.slice(0, room);
  return {
    state: {
      ...state,
      files: [...state.files, ...taken],
      trayIds: [...state.trayIds, ...taken.map((f) => f.id)],
    },
    rejected: fresh.length - taken.length,
  };
}

/** Remove a file entirely — from the tray or from whichever bin holds it. */
export function removeFile(state: SorterState, fileId: string): SorterState {
  return {
    files: state.files.filter((f) => f.id !== fileId),
    trayIds: state.trayIds.filter((id) => id !== fileId),
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

/** Everything, tray and bins alike, into one bin. The other half of `separateTray`. */
export function combineAll(
  state: SorterState,
  mintId: () => string,
  seed: (file: StagedFile) => { name: string; anchorIso: string | null }
): SorterState {
  if (!state.files.length) return state;
  const first = state.files[0]!;
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
  bytes: number;
};

/**
 * What pressing Read will actually upload: one entry per bin, then one per leftover file.
 *
 * Empty bins produce nothing — an empty bin is a bin somebody made and did not use, not a
 * note about nothing.
 */
export function planUploads(
  state: SorterState,
  seed: (file: StagedFile) => { name: string; anchorIso: string | null }
): PlannedUpload[] {
  const sizeOf = (ids: readonly string[]) =>
    ids.reduce((n, id) => n + (fileById(state, id)?.size ?? 0), 0);

  const fromBins = state.bins
    .filter((b) => b.fileIds.length > 0)
    .map<PlannedUpload>((b) => ({
      binId: b.id,
      label: b.name.trim() || fileById(state, b.fileIds[0]!)?.name || "Untitled note",
      fileIds: [...b.fileIds],
      anchorIso: b.anchorIso,
      bytes: sizeOf(b.fileIds),
    }));

  const loose = state.trayIds.flatMap<PlannedUpload>((id) => {
    const file = fileById(state, id);
    if (!file) return [];
    const { name, anchorIso } = seed(file);
    return [{ binId: null, label: name, fileIds: [id], anchorIso, bytes: file.size }];
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
 */
export function oversizedUploads(
  uploads: readonly PlannedUpload[],
  maxBytes: number
): PlannedUpload[] {
  return uploads.filter((u) => u.bytes > maxBytes);
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
  return null;
}
