/**
 * Transforms granular machine speech-to-text segments (which arrive every 2-3 seconds)
 * into human-readable, speaker-attributed conversational paragraphs, with de-duplication.
 *
 * Client-safe — pure data transformations with no server dependencies.
 */

export type RawSegment = {
  seq: number;
  startMs: number;
  endMs: number;
  speaker?: string | null;
  text: string;
};

export type TranscriptParagraph = {
  speaker: string | null;
  speakerName: string;
  startMs: number;
  endMs: number;
  text: string;
  seqs: number[];
};

/**
 * Maximum pause (in milliseconds) between consecutive utterances from the same speaker
 * before splitting into a new paragraph. 6 seconds represents a natural conversational break.
 */
export const MAX_PARAGRAPH_PAUSE_MS = 6_000;

/**
 * Maximum character length of a single paragraph from a continuous speaker monologue
 * before breaking into a new paragraph (~150-200 words).
 */
export const MAX_PARAGRAPH_CHARS = 750;

/**
 * Clean and normalize a text snippet for comparison and concatenation.
 */
export function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Remove duplicate overlapping words at the boundary between two adjacent segments.
 *
 * For example:
 *   prev: "I think we should"
 *   next: "we should definitely start"
 *   returns: "definitely start"
 */
export function trimBoundaryOverlap(prevText: string, nextText: string): string {
  const prevClean = cleanText(prevText);
  const nextClean = cleanText(nextText);
  if (!prevClean || !nextClean) return nextClean;

  const prevWords = prevClean.split(" ");
  const nextWords = nextClean.split(" ");

  // Check overlap of 1 to 6 words
  const maxOverlap = Math.min(6, prevWords.length, nextWords.length);
  for (let len = maxOverlap; len >= 1; len--) {
    const prevTail = prevWords.slice(-len).map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, "")).join(" ");
    const nextHead = nextWords.slice(0, len).map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, "")).join(" ");

    if (prevTail && prevTail === nextHead) {
      return nextWords.slice(len).join(" ");
    }
  }

  return nextClean;
}

/**
 * Deduplicate a sequence of transcript segments.
 *
 * Eliminates:
 * 1. Exact or near-identical duplicate segments (from echo or repeated chunks) within a short window.
 * 2. Redundant boundary phrases.
 * 3. Segments that are completely contained within an adjacent segment.
 */
export function deduplicateSegments<T extends RawSegment>(segments: readonly T[]): T[] {
  if (segments.length <= 1) return [...segments];

  const sorted = [...segments].sort((a, b) => (a.startMs !== b.startMs ? a.startMs - b.startMs : a.seq - b.seq));
  const result: T[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i]!;
    const currentText = cleanText(current.text);
    if (!currentText) continue;

    const prev = result[result.length - 1];
    if (!prev) {
      result.push({ ...current, text: currentText });
      continue;
    }

    const prevText = cleanText(prev.text);

    // Compare normalized (letters and digits)
    const normPrev = prevText.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    const normCurrent = currentText.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();

    // Exact duplicate within 15 seconds: drop the duplicate
    const timeDiff = Math.abs(current.startMs - prev.startMs);
    if (timeDiff <= 15_000) {
      if (normCurrent === normPrev) {
        continue;
      }
      // If current is completely contained at the end of prev
      if (normPrev.endsWith(normCurrent)) {
        continue;
      }
      // If prev is completely contained at the beginning of current (current is a fuller revision)
      if (normCurrent.startsWith(normPrev)) {
        result[result.length - 1] = {
          ...current,
          text: currentText,
          seq: prev.seq,
          startMs: Math.min(prev.startMs, current.startMs),
          endMs: Math.max(prev.endMs, current.endMs),
        };
        continue;
      }
    }

    // Check boundary overlap
    const trimmed = trimBoundaryOverlap(prevText, currentText);
    if (!trimmed) {
      // Entire segment was an overlap repetition
      continue;
    }

    result.push({ ...current, text: trimmed });
  }

  return result;
}

/**
 * Format speaker display name from speaker label and name map.
 */
function resolveSpeakerName(speaker: string | null | undefined, names?: ReadonlyMap<string, string>): string {
  if (!speaker) return "Speaker";
  if (names?.has(speaker)) return names.get(speaker)!;
  if (speaker === "you") return "You";
  const m = /^speaker-(\d+)$/.exec(speaker);
  if (m) return `Speaker ${m[1]}`;
  return speaker;
}

/**
 * Groups fine-grained segments into natural conversational paragraphs by speaker.
 *
 * Consecutive utterances by the same speaker within `MAX_PARAGRAPH_PAUSE_MS` are combined
 * into coherent paragraphs with proper sentence spacing and boundary deduplication.
 */
export function groupSegmentsIntoParagraphs(
  segments: readonly RawSegment[],
  names?: ReadonlyMap<string, string>
): TranscriptParagraph[] {
  const deduped = deduplicateSegments(segments);
  if (deduped.length === 0) return [];

  const paragraphs: TranscriptParagraph[] = [];
  let current: TranscriptParagraph | null = null;

  for (const seg of deduped) {
    const text = cleanText(seg.text);
    if (!text) continue;

    const speaker = seg.speaker ?? null;
    const speakerName = resolveSpeakerName(speaker, names);

    if (!current) {
      current = {
        speaker,
        speakerName,
        startMs: seg.startMs,
        endMs: seg.endMs,
        text,
        seqs: [seg.seq],
      };
      continue;
    }

    const sameSpeaker = current.speaker === speaker;
    const pauseMs = seg.startMs - current.endMs;
    const isShortPause = pauseMs >= -500 && pauseMs <= MAX_PARAGRAPH_PAUSE_MS;
    const isUnderCharLimit = current.text.length + text.length < MAX_PARAGRAPH_CHARS;

    if (sameSpeaker && isShortPause && isUnderCharLimit) {
      // Join to current paragraph
      const trimmedText = trimBoundaryOverlap(current.text, text);
      if (trimmedText) {
        const needsSpace = !/[.!?,\s]$/.test(current.text);
        current.text = `${current.text}${needsSpace ? " " : " "}${trimmedText}`.trim();
        current.endMs = Math.max(current.endMs, seg.endMs);
        current.seqs.push(seg.seq);
      }
    } else {
      // Finalize current and start new paragraph
      paragraphs.push(current);
      current = {
        speaker,
        speakerName,
        startMs: seg.startMs,
        endMs: seg.endMs,
        text,
        seqs: [seg.seq],
      };
    }
  }

  if (current) {
    paragraphs.push(current);
  }

  return paragraphs;
}

/**
 * Formats a paragraph as `"Speaker: Text"` for feeding into AI prompts and analysis.
 */
export function formatTranscriptParagraph(p: TranscriptParagraph): string {
  const text = p.text.trim();
  const label = p.speakerName.trim();
  return label ? `${label}: ${text}` : text;
}
