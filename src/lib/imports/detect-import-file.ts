/**
 * What is this file, and which importer should it go to?
 *
 * The page's promise is "drop anything here" — a LinkedIn ZIP, a folder, a loose CSV, a
 * calendar. That promise is only keepable if something downstream can answer this question
 * without asking the person, so this module is the routing table that replaces the three tabs
 * a user used to have to choose between.
 *
 * ## Routing, not refusing
 *
 * The importers already know how to say "this looks like a Messages export, not Connections".
 * Those refusals stay where they are as a backstop for the per-card pickers, but reaching one
 * from a drop is a failure of this module: the right answer to a mislabelled file is to send
 * it to the importer that wants it, not to hand the person an error about a card they did not
 * pick. That is why `head` beats `name` on conflict.
 *
 * ## Pure enough to test
 *
 * `classifyByName` and `classifyByHead` are pure string functions, and the orchestrator's only
 * impurities are `File.slice().text()` and a dynamic `jszip` import. Nothing here reaches
 * `@/db`, so `scripts/smoke-import-detect.ts` runs in the pure tier with plain fixtures.
 */
import {
  looksLikeConnectionsExport,
  looksLikeMessagesExport,
  stripLinkedInConnectionsPreamble,
} from "@/lib/linkedin-connections";
import { looksLikeContactsCsv } from "@/lib/contacts-file";
import { headerFields } from "@/lib/imports/csv-header";
import { isIgnorableFile, type DroppedFile } from "@/lib/capture/file-drop";

/**
 * Deliberately the same strings as `imports.import_type`.
 *
 * The runner has its own shorter vocabulary (`ImportJobKind`: "connections", "messages", …).
 * Two vocabularies is already one too many; three would be unmaintainable, so this aliases the
 * database's and the queue owns the single bridge to the runner's.
 * `scripts/smoke-import-sources.ts` asserts these literals still match the adapter constants.
 */
export type ImportTarget =
  | "linkedin_connections"
  | "linkedin_messages"
  | "contacts_file"
  | "calendar_ics"
  | "calendar_csv"
  | "unknown";

/**
 * How sure we are, which decides whether a later signal may overrule an earlier one.
 * `certain` comes from a name LinkedIn controls or a format's own magic line; `likely` from a
 * header sniff; `guess` from a filename pattern anyone could have typed.
 */
export type DetectConfidence = "certain" | "likely" | "guess";

export type Detected = {
  file: File;
  /** Folder path relative to what was dropped, or the ZIP member path. "" at the top level. */
  path: string;
  target: ImportTarget;
  confidence: DetectConfidence;
  /** One clause, written to be shown to the person as-is. Never a file path. */
  reason: string;
  /**
   * Text already in hand. Set for ZIP members, which had to be decompressed to be identified
   * and must not be read a second time — a `File` cannot be recovered from a ZIP entry anyway.
   */
  text?: string;
  bytes: number;
};

export type DetectionResult = {
  /** One per target, in run order. What the queue will actually import. */
  staged: Detected[];
  /** Not recognised. Never an error — a LinkedIn archive is mostly files nobody asked for. */
  ignored: Detected[];
  /** Recognised, but a better file already claimed that target, or it was too big. */
  skipped: Detected[];
  /** The drop hit a cap and there was more on disk. */
  truncated: boolean;
};

/**
 * The order imports run in, regardless of the order files were dropped.
 *
 * Connections before messages is not cosmetic. The messages preview matches conversation
 * partners against contacts that already exist, so running messages first makes every partner
 * look new and does the deduplication backwards.
 */
export const RUN_ORDER: readonly ImportTarget[] = [
  "linkedin_connections",
  "contacts_file",
  "linkedin_messages",
  "calendar_ics",
  "calendar_csv",
];

/** Enough to hold a header row and a few data rows of even a very wide export. */
const HEAD_BYTES = 65_536;
/** Header plus a little context; more than this and we are parsing the file, not sniffing it. */
const HEAD_LINES = 20;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

/** The file's own name, ignoring the folder it arrived in. */
function baseName(name: string): string {
  return name.split("/").pop() ?? name;
}

type Classification = {
  target: ImportTarget;
  confidence: DetectConfidence;
  reason: string;
};

/**
 * What the filename alone says.
 *
 * LinkedIn's archive member names are stable and have been for years, so `Connections.csv` is
 * worth treating as certain — it saves reading the file at all in the common case. Everything
 * else here is a `guess` that a header sniff is expected to confirm or overrule.
 */
export function classifyByName(name: string): Classification | null {
  const base = baseName(name).toLowerCase();
  const ext = extensionOf(base);

  if (ext === ".ics" || ext === ".ical" || ext === ".ifb") {
    return {
      target: "calendar_ics",
      confidence: "certain",
      reason: "a calendar file",
    };
  }
  if (ext === ".vcf" || ext === ".vcard") {
    return {
      target: "contacts_file",
      confidence: "certain",
      reason: "a contact card file",
    };
  }
  if (ext !== ".csv") return null;

  if (/^connections\.csv$/.test(base)) {
    return {
      target: "linkedin_connections",
      confidence: "certain",
      reason: "your LinkedIn connections",
    };
  }
  if (/^messages\.csv$/.test(base)) {
    return {
      target: "linkedin_messages",
      confidence: "certain",
      reason: "your LinkedIn messages",
    };
  }
  if (
    /contacts?\.csv$/.test(base) ||
    /^(google|outlook|icloud|apple)[ _-]/.test(base)
  ) {
    return {
      target: "contacts_file",
      confidence: "guess",
      reason: "a contacts file",
    };
  }
  return null;
}

/** Calendar CSVs name the event and when it starts; nothing else does both. */
function looksLikeCalendarCsv(fields: string[]): boolean {
  const lower = fields.map((f) => f.trim().toLowerCase());
  const has = (...keys: string[]) => keys.some((k) => lower.includes(k));
  const titled = has("subject", "title", "summary", "event");
  const timed = has(
    "start",
    "start date",
    "starts",
    "dtstart",
    "date",
    "start time",
  );
  if (titled && timed) return true;
  // Outlook's export leads with attendee columns; a file with those and a start is a calendar
  // even when its title column is named something we do not list.
  return (
    timed && has("attendees", "required attendees", "organizer", "organiser")
  );
}

/**
 * What the first few KB say. `head` is raw file text, not lowercased — the vCard and iCalendar
 * checks want the real casing, and the CSV predicates lowercase their own fields.
 */
export function classifyByHead(head: string): Classification | null {
  const trimmed = head.replace(/^﻿/, "").trimStart();

  if (/^BEGIN:VCALENDAR/i.test(trimmed) || /^BEGIN:VEVENT/im.test(trimmed)) {
    return {
      target: "calendar_ics",
      confidence: "certain",
      reason: "a calendar file",
    };
  }
  if (/^BEGIN:VCARD/i.test(trimmed)) {
    return {
      target: "contacts_file",
      confidence: "certain",
      reason: "contact cards",
    };
  }

  // The preamble strip is load-bearing: a real Connections.csv opens with three `Notes:` lines,
  // so parsing it unstripped yields the preamble as the header and matches nothing at all.
  const fields = headerFields(stripLinkedInConnectionsPreamble(trimmed));
  if (!fields.length) return null;

  if (looksLikeConnectionsExport(fields)) {
    return {
      target: "linkedin_connections",
      confidence: "likely",
      reason: "your LinkedIn connections",
    };
  }
  if (looksLikeMessagesExport(fields)) {
    return {
      target: "linkedin_messages",
      confidence: "likely",
      reason: "your LinkedIn messages",
    };
  }
  // Calendar before contacts: a calendar CSV often carries an organizer email, which the
  // contacts recogniser is permissive enough to accept.
  if (looksLikeCalendarCsv(fields)) {
    return {
      target: "calendar_csv",
      confidence: "likely",
      reason: "a calendar export",
    };
  }
  if (looksLikeContactsCsv(fields)) {
    return {
      target: "contacts_file",
      confidence: "likely",
      reason: "a contacts file",
    };
  }
  return null;
}

/** Read only as much of a file as identifying it needs. */
async function readHead(file: File): Promise<string> {
  const slice = file.slice(0, HEAD_BYTES);
  const text = await slice.text();
  const lines = text.split(/\r?\n/);
  return lines.length > HEAD_LINES
    ? lines.slice(0, HEAD_LINES).join("\n")
    : text;
}

/**
 * Decide one file.
 *
 * The header is ground truth and the name is a label anyone can change, so the head wins
 * outright whenever it says anything at all — that is what turns a `Connections.csv` full of
 * messages from a refusal into a routing decision. The name is the fallback for files whose
 * head is inconclusive (a vCard-less .vcf) or unreadable (a binary named .csv).
 */
async function classifyFile(entry: DroppedFile): Promise<Detected> {
  const { file, path } = entry;
  const base = { file, path, bytes: file.size };

  let byHead: Classification | null = null;
  try {
    byHead = classifyByHead(await readHead(file));
  } catch {
    // Unreadable as text — a binary that happens to end in .csv. The name is all we have.
    byHead = null;
  }

  const best = byHead ?? classifyByName(file.name);
  if (!best) {
    return {
      ...base,
      target: "unknown",
      confidence: "guess",
      reason: "not something Orbit reads",
    };
  }
  return { ...base, ...best };
}

/** Names inside a LinkedIn archive worth extracting. Everything else in it is noise. */
const ZIP_MEMBERS: { pattern: RegExp; target: ImportTarget; reason: string }[] =
  [
    {
      pattern: /(^|\/)connections\.csv$/i,
      target: "linkedin_connections",
      reason: "your LinkedIn connections",
    },
    {
      pattern: /(^|\/)messages\.csv$/i,
      target: "linkedin_messages",
      reason: "your LinkedIn messages",
    },
  ];

/**
 * Pull the parts of a ZIP worth importing.
 *
 * Extracts only matched members. A LinkedIn archive is mostly `Invitations.csv`,
 * `Ad_Targeting.csv` and `Rich_Media.csv` — dozens of files that must cost nothing and appear
 * nowhere, so decompressing them to find that out would be the wrong trade.
 */
async function expandZip(entry: DroppedFile): Promise<Detected[]> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await entry.file.arrayBuffer());
  const members = Object.values(zip.files).filter(
    (f) => !f.dir && !isIgnorableFile(baseName(f.name)),
  );

  const out: Detected[] = [];
  for (const known of ZIP_MEMBERS) {
    const member = members.find((m) => known.pattern.test(m.name));
    if (!member) continue;
    const text = await member.async("string");
    out.push({
      file: entry.file,
      path: member.name,
      target: known.target,
      confidence: "certain",
      reason: known.reason,
      text,
      bytes: text.length,
    });
  }

  // A ZIP holding exactly one CSV and none of LinkedIn's names: sniff it, since somebody
  // zipped a single export rather than downloading an archive.
  if (!out.length) {
    const csvs = members.filter(
      (m) => extensionOf(baseName(m.name)) === ".csv",
    );
    const ics = members.filter((m) =>
      [".ics", ".ical"].includes(extensionOf(baseName(m.name))),
    );
    const only = csvs.length === 1 ? csvs[0] : ics.length === 1 ? ics[0] : null;
    if (only) {
      const text = await only.async("string");
      const byHead = classifyByHead(text.slice(0, HEAD_BYTES));
      if (byHead) {
        out.push({
          file: entry.file,
          path: only.name,
          target: byHead.target,
          confidence: byHead.confidence,
          reason: byHead.reason,
          text,
          bytes: text.length,
        });
      }
    }
  }

  if (!out.length) {
    out.push({
      file: entry.file,
      path: entry.path,
      target: "unknown",
      confidence: "guess",
      reason: "a ZIP with nothing Orbit reads inside",
      bytes: entry.file.size,
    });
  }
  return out;
}

export type DetectOptions = {
  /** Bytes past which a single file is refused rather than staged. */
  maxBytes?: number;
  /** Set when the drop itself was capped, so the caller can say so. */
  truncated?: boolean;
};

/**
 * Identify everything in one drop and decide what the queue will run.
 *
 * Returns three lists on purpose. `ignored` is not a failure — dropping a LinkedIn archive
 * means dropping thirty files nobody asked about — and conflating it with `skipped` would make
 * a normal drop look like it went wrong.
 */
export async function detectImportFiles(
  files: readonly DroppedFile[],
  options: DetectOptions = {},
): Promise<DetectionResult> {
  const { maxBytes, truncated = false } = options;

  const detected: Detected[] = [];
  for (const entry of files) {
    if (isIgnorableFile(baseName(entry.file.name))) continue;
    if (extensionOf(entry.file.name) === ".zip") {
      detected.push(...(await expandZip(entry)));
    } else {
      detected.push(await classifyFile(entry));
    }
  }

  const ignored = detected.filter((d) => d.target === "unknown");
  const recognised = detected.filter((d) => d.target !== "unknown");
  const skipped: Detected[] = [];

  const oversize = recognised.filter(
    (d) => maxBytes != null && d.bytes > maxBytes,
  );
  for (const d of oversize) {
    skipped.push({ ...d, reason: "too big to import in one go" });
  }
  const usable = recognised.filter((d) => !oversize.includes(d));

  // One file per target. Two `Connections.csv` from a split archive is a real case; keeping the
  // larger and saying so is easier to explain than an N-deep sub-queue, and the engine
  // deduplicates contacts anyway.
  const staged: Detected[] = [];
  for (const target of RUN_ORDER) {
    const candidates = usable.filter((d) => d.target === target);
    if (!candidates.length) continue;
    const [winner, ...rest] = [...candidates].sort((a, b) => b.bytes - a.bytes);
    staged.push(winner);
    for (const other of rest) {
      skipped.push({
        ...other,
        reason: "a bigger file of the same kind was used instead",
      });
    }
  }

  return { staged, ignored, skipped, truncated };
}
