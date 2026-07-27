import { parseIcsEvents } from "@/lib/calendar-import";
import {
  transcribeAudioWithAI,
  transcribeImagesWithAI,
  type CaptureParseHints,
} from "@/lib/ai";

export type CaptureMediaFile = {
  filename: string;
  mimeType: string;
  /** Raw base64 (no data: URL prefix). */
  base64: string;
};

export type NormalizedCaptureInput = {
  text: string;
  hints: CaptureParseHints;
  /** Human-readable labels of what was ingested (for UI). */
  sources: string[];
};

const MAX_IMAGES = 8;
const MAX_AUDIO_FILES = 3;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_SINGLE_BYTES = 12 * 1024 * 1024;

function extOf(filename: string) {
  const i = filename.lastIndexOf(".");
  return i >= 0 ? filename.slice(i + 1).toLowerCase() : "";
}

function decodedBytes(base64: string) {
  // Rough decoded size from base64 length.
  return Math.floor((base64.length * 3) / 4);
}

function stripDataUrl(base64OrDataUrl: string) {
  const m = base64OrDataUrl.match(/^data:[^;]+;base64,(.+)$/i);
  return m ? m[1]! : base64OrDataUrl;
}

function isImage(file: CaptureMediaFile) {
  const ext = extOf(file.filename);
  return (
    file.mimeType.startsWith("image/") ||
    ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif"].includes(ext)
  );
}

function isAudio(file: CaptureMediaFile) {
  const ext = extOf(file.filename);
  return (
    file.mimeType.startsWith("audio/") ||
    ["webm", "mp3", "wav", "m4a", "ogg", "aac", "mp4", "mpeg"].includes(ext)
  );
}

function isIcs(file: CaptureMediaFile) {
  const ext = extOf(file.filename);
  return (
    ext === "ics" ||
    file.mimeType.includes("calendar") ||
    file.mimeType === "text/calendar"
  );
}

function isEml(file: CaptureMediaFile) {
  const ext = extOf(file.filename);
  return (
    ext === "eml" ||
    file.mimeType === "message/rfc822" ||
    file.mimeType === "application/eml"
  );
}

function isPlainText(file: CaptureMediaFile) {
  const ext = extOf(file.filename);
  return (
    file.mimeType.startsWith("text/") ||
    ["txt", "md", "markdown", "csv"].includes(ext)
  );
}

function decodeTextFile(file: CaptureMediaFile) {
  return Buffer.from(stripDataUrl(file.base64), "base64").toString("utf8");
}

function toIsoDate(d: Date | null | undefined): string | null {
  if (!d || Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Turn ICS calendar text into capture notes + seed attendees. */
export function normalizeIcsToCapture(icsText: string): NormalizedCaptureInput {
  const events = parseIcsEvents(icsText);
  if (!events.length) {
    return {
      text: icsText.trim(),
      hints: {},
      sources: ["calendar"],
    };
  }

  const seedPeople: CaptureParseHints["seedPeople"] = [];
  const seen = new Set<string>();
  const blocks: string[] = [];
  let eventDate: string | null = null;

  for (const ev of events) {
    if (!eventDate) eventDate = toIsoDate(ev.start);

    const people = [
      ...(ev.organizer ? [ev.organizer] : []),
      ...ev.attendees,
    ];
    for (const p of people) {
      const key = `${(p.email || "").toLowerCase()}|${(p.name || "").toLowerCase()}`;
      if (!p.email && !p.name) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      seedPeople!.push({ name: p.name || null, email: p.email || null });
    }

    const lines = [
      ev.summary ? `Event: ${ev.summary}` : null,
      ev.start ? `When: ${ev.start.toISOString()}` : null,
      ev.location ? `Where: ${ev.location}` : null,
      people.length
        ? `Attendees:\n${people
            .map((p) => {
              if (p.name && p.email) return `- ${p.name} <${p.email}>`;
              return `- ${p.name || p.email}`;
            })
            .join("\n")}`
        : null,
      ev.description ? `Notes:\n${ev.description}` : null,
    ].filter(Boolean);
    blocks.push(lines.join("\n"));
  }

  return {
    text: blocks.join("\n\n---\n\n"),
    hints: {
      eventDate,
      seedPeople,
      interactionType: "meeting",
    },
    sources: ["calendar"],
  };
}

/**
 * Best-effort .eml / forwarded-email normalization.
 * Keeps Subject/From/To/Cc + body; strips heavy quoted history when obvious.
 */
export function normalizeEmailToCapture(raw: string): NormalizedCaptureInput {
  const text = raw.replace(/\r\n/g, "\n");
  const headerEnd = text.search(/\n\n/);
  const headerBlock = headerEnd >= 0 ? text.slice(0, headerEnd) : "";
  let body = headerEnd >= 0 ? text.slice(headerEnd + 2) : text;

  const getHeader = (name: string) => {
    const re = new RegExp(`^${name}:\\s*(.+)$`, "im");
    const m = headerBlock.match(re);
    return m?.[1]?.trim() || "";
  };

  const subject = getHeader("Subject");
  const from = getHeader("From");
  const to = getHeader("To");
  const cc = getHeader("Cc");
  const dateHeader = getHeader("Date");

  // Drop common reply/forward quoted tails.
  body = body
    .split(/\nOn .+ wrote:\n/)[0]!
    .split(/\n-{2,} Original Message -{2,}\n/i)[0]!
    .split(/\nFrom: .+\nSent: /)[0]!
    .trim();

  const seedPeople: Array<{ name: string | null; email: string | null }> = [];
  const emailRe = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;
  const nameEmailRe =
    /(?:"?([^"<]+)"?\s*)?<([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>/gi;

  function collect(field: string) {
    if (!field) return;
    let match: RegExpExecArray | null;
    const named = new Set<string>();
    nameEmailRe.lastIndex = 0;
    while ((match = nameEmailRe.exec(field))) {
      const name = match[1]?.trim() || null;
      const email = match[2]?.trim() || null;
      if (!email) continue;
      named.add(email.toLowerCase());
      seedPeople.push({ name, email });
    }
    emailRe.lastIndex = 0;
    while ((match = emailRe.exec(field))) {
      const email = match[1]?.trim();
      if (!email || named.has(email.toLowerCase())) continue;
      seedPeople.push({ name: null, email });
    }
  }

  collect(from);
  collect(to);
  collect(cc);

  let eventDate: string | null = null;
  if (dateHeader) {
    const d = new Date(dateHeader);
    if (!Number.isNaN(d.getTime())) eventDate = toIsoDate(d);
  }

  const preamble = [
    subject ? `Subject: ${subject}` : null,
    from ? `From: ${from}` : null,
    to ? `To: ${to}` : null,
    cc ? `Cc: ${cc}` : null,
    dateHeader ? `Date: ${dateHeader}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const out = [preamble, body].filter(Boolean).join("\n\n").trim();

  return {
    text: out || text.trim(),
    hints: {
      eventDate,
      seedPeople: seedPeople.length ? seedPeople : undefined,
      interactionType: "email",
    },
    sources: ["email"],
  };
}

/** Detect pasted calendar/email text without a file upload. */
export function normalizePastedCaptureText(text: string): NormalizedCaptureInput {
  const trimmed = text.trim();
  if (!trimmed) {
    return { text: "", hints: {}, sources: [] };
  }

  if (/BEGIN:VCALENDAR/i.test(trimmed) || /BEGIN:VEVENT/i.test(trimmed)) {
    return normalizeIcsToCapture(trimmed);
  }

  // Rough forwarded-email / .eml paste detection.
  const looksLikeEmail =
    (/^From:\s.+/im.test(trimmed) && /^Subject:\s.+/im.test(trimmed)) ||
    /^Content-Type:\s*multipart\//im.test(trimmed) ||
    /^-{2,}\s*Forwarded message\s*-{2,}/im.test(trimmed);

  if (looksLikeEmail) {
    return normalizeEmailToCapture(trimmed);
  }

  return { text: trimmed, hints: {}, sources: ["text"] };
}

function mergeHints(
  base: CaptureParseHints,
  extra: CaptureParseHints
): CaptureParseHints {
  const seedPeople = [...(base.seedPeople || []), ...(extra.seedPeople || [])];
  const seen = new Set<string>();
  const deduped = seedPeople.filter((p) => {
    const key = `${(p.email || "").toLowerCase()}|${(p.name || "").toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return Boolean(p.name || p.email);
  });

  return {
    eventDate: base.eventDate || extra.eventDate || null,
    seedPeople: deduped.length ? deduped : undefined,
    interactionType: base.interactionType || extra.interactionType || null,
  };
}

/**
 * Normalize text + optional media uploads into a single capture corpus.
 * Media is processed ephemerally (not stored).
 */
export async function normalizeCaptureInput(
  userId: string,
  input: {
    text?: string;
    files?: CaptureMediaFile[];
  }
): Promise<NormalizedCaptureInput> {
  const files = (input.files || []).map((f) => ({
    ...f,
    base64: stripDataUrl(f.base64),
    mimeType: f.mimeType || "application/octet-stream",
  }));

  let totalBytes = 0;
  for (const f of files) {
    const size = decodedBytes(f.base64);
    if (size > MAX_SINGLE_BYTES) {
      throw new Error(
        `File "${f.filename}" is too large (max ${Math.floor(MAX_SINGLE_BYTES / (1024 * 1024))}MB).`
      );
    }
    totalBytes += size;
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error(
      `Total upload too large (max ${Math.floor(MAX_TOTAL_BYTES / (1024 * 1024))}MB).`
    );
  }

  const chunks: string[] = [];
  let hints: CaptureParseHints = {};
  const sources: string[] = [];

  const pasted = (input.text || "").trim();
  if (pasted) {
    const normalized = normalizePastedCaptureText(pasted);
    if (normalized.text.trim()) chunks.push(normalized.text.trim());
    hints = mergeHints(hints, normalized.hints);
    sources.push(...normalized.sources);
  }

  const images: CaptureMediaFile[] = [];
  const audios: CaptureMediaFile[] = [];

  for (const file of files) {
    if (isIcs(file)) {
      const normalized = normalizeIcsToCapture(decodeTextFile(file));
      if (normalized.text.trim()) chunks.push(normalized.text.trim());
      hints = mergeHints(hints, normalized.hints);
      sources.push(`calendar:${file.filename}`);
      continue;
    }
    if (isEml(file)) {
      const normalized = normalizeEmailToCapture(decodeTextFile(file));
      if (normalized.text.trim()) chunks.push(normalized.text.trim());
      hints = mergeHints(hints, normalized.hints);
      sources.push(`email:${file.filename}`);
      continue;
    }
    if (isPlainText(file)) {
      const text = decodeTextFile(file).trim();
      if (text) {
        const normalized = normalizePastedCaptureText(text);
        chunks.push(normalized.text.trim() || text);
        hints = mergeHints(hints, normalized.hints);
        sources.push(`text:${file.filename}`);
      }
      continue;
    }
    if (isImage(file)) {
      images.push(file);
      continue;
    }
    if (isAudio(file)) {
      audios.push(file);
      continue;
    }
    throw new Error(
      `Unsupported file type: ${file.filename || file.mimeType}`
    );
  }

  if (images.length > MAX_IMAGES) {
    throw new Error(`Too many images (max ${MAX_IMAGES}).`);
  }
  if (audios.length > MAX_AUDIO_FILES) {
    throw new Error(`Too many audio files (max ${MAX_AUDIO_FILES}).`);
  }

  if (images.length) {
    const text = await transcribeImagesWithAI(
      userId,
      images.map((img) => ({
        mimeType: img.mimeType.startsWith("image/")
          ? img.mimeType
          : "image/jpeg",
        base64: img.base64,
      }))
    );
    if (text.trim()) {
      chunks.push(text.trim());
      sources.push(`photos:${images.length}`);
    }
  }

  for (const audio of audios) {
    const text = await transcribeAudioWithAI(userId, {
      mimeType: audio.mimeType.startsWith("audio/")
        ? audio.mimeType
        : "audio/webm",
      base64: audio.base64,
      filename: audio.filename,
    });
    if (text.trim()) {
      chunks.push(text.trim());
      sources.push(`voice:${audio.filename}`);
    }
  }

  const text = chunks.filter(Boolean).join("\n\n---\n\n").trim();
  if (!text) {
    throw new Error("No usable text found in the capture input");
  }

  return {
    text,
    hints,
    sources: sources.length ? sources : ["text"],
  };
}
