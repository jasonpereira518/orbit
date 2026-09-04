import type {
  ExtractedField,
  FieldConfidence,
  PageContext,
  PageIdentity,
  PageKind,
} from "@contract";

export type { PageContext, PageIdentity, PageKind };

/**
 * `withProfile` is the one flag in this file that can turn a read into an interaction. It
 * must only ever be set by the panel's explicit "Capture experience" button — see
 * `extension/src/inject/dom/expand.ts`'s header for why, and its bounds. Every other caller
 * of `extract` omits it, and every adapter but LinkedIn's ignores it entirely.
 */
export type ExtractOptions = { withProfile?: boolean };

export interface SiteAdapter {
  id: string;
  /** Bump on any selector change. Logged server-side so DOM churn is visible
   *  in telemetry rather than arriving as a support email. */
  adapterVersion: string;
  matches(url: URL): boolean;
  /**
   * Synchronous for every adapter and every ordinary call. Only the LinkedIn adapter, and
   * only when `options.withProfile` is set on a person page, returns a Promise — because
   * that is the one path that waits on `expandProfileSections` before reading the page.
   */
  extract(url: URL, options?: ExtractOptions): PageContext | Promise<PageContext>;
}

export function field(
  value: string | null | undefined,
  source: string,
  confidence: FieldConfidence
): ExtractedField {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return { value: trimmed, source, confidence };
}

export function emptyIdentity(): PageIdentity {
  return {
    name: null,
    headline: null,
    title: null,
    company: null,
    location: null,
    school: null,
    email: null,
    handle: null,
    profileUrl: null,
    photoUrl: null,
  };
}

/**
 * Run a field getter without letting it take down the extraction.
 *
 * Every selector in every adapter goes through this. A broken selector must
 * degrade exactly one field — the whole design rests on the extraction still
 * returning a usable URL when LinkedIn reshuffles their DOM.
 */
export function attempt<T>(
  warnings: string[],
  label: string,
  fn: () => T
): T | null {
  try {
    return fn();
  } catch {
    warnings.push(`extract-failed:${label}`);
    return null;
  }
}

/** Prefer the first non-null field, so adapters can list sources by trust. */
export function preferField(
  ...candidates: (ExtractedField | null)[]
): ExtractedField {
  for (const candidate of candidates) {
    if (candidate) return candidate;
  }
  return null;
}
