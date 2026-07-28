import type { CaptureParseHints } from "@/lib/ai";

const STORAGE_KEY = "orbit-capture-notes-draft-v1";

export type CaptureNotesDraft = {
  notes: string;
  fileName: string | null;
  ingestSources: string[];
  hints: CaptureParseHints | null;
  updatedAt: number;
};

function canUseStorage() {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

export function loadCaptureNotesDraft(): CaptureNotesDraft | null {
  if (!canUseStorage()) return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CaptureNotesDraft>;
    if (typeof parsed.notes !== "string") return null;
    return {
      notes: parsed.notes,
      fileName: typeof parsed.fileName === "string" ? parsed.fileName : null,
      ingestSources: Array.isArray(parsed.ingestSources)
        ? parsed.ingestSources.filter((s): s is string => typeof s === "string")
        : [],
      hints:
        parsed.hints && typeof parsed.hints === "object" ? parsed.hints : null,
      updatedAt:
        typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function saveCaptureNotesDraft(
  draft: Omit<CaptureNotesDraft, "updatedAt">
) {
  if (!canUseStorage()) return;
  try {
    if (!draft.notes.trim()) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    const payload: CaptureNotesDraft = {
      ...draft,
      updatedAt: Date.now(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore quota / private mode
  }
}

export function clearCaptureNotesDraft() {
  if (!canUseStorage()) return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
