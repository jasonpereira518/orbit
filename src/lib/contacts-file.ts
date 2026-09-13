import Papa from "papaparse";
import { isRoleEmail } from "@/lib/duplicates";

/**
 * Address-book file parsing: vCard (.vcf) and the contacts CSVs Google and Outlook export.
 *
 * This is the no-OAuth path into Orbit for the people on someone's phone. Google Contacts,
 * iPhone/iCloud, Android, macOS Contacts and Outlook can all export a file, and between them
 * they produce exactly two shapes — a vCard stream (versions 2.1, 3.0 and 4.0, depending on
 * who wrote it) or a CSV with one of three header dialects — so both are normalized here into
 * one flat `ContactsFileRow` and nothing downstream needs to know which one arrived.
 *
 * DB-free and side-effect-free on purpose, like `linkedin-connections.ts`: the server actions
 * call it twice (preview, then again on confirm, rather than trusting rows the client sent
 * back), the client calls `compactContactsFileText` before uploading, and
 * `scripts/smoke-contacts-file.ts` exercises all of it without a database.
 *
 * Expected failures — an empty file, a LinkedIn export dropped on the wrong card, a CSV with no
 * columns we recognise — throw `ContactsFileError`, whose messages are written to be read by a
 * person. Anything else that throws is a bug, and the action says so generically rather than
 * forwarding whatever the runtime happened to put in `err.message`.
 */

export type ContactsFileFormat = "vcard" | "google_csv" | "outlook_csv" | "csv";

export const CONTACTS_FILE_FORMAT_LABELS: Record<ContactsFileFormat, string> = {
  vcard: "vCard",
  google_csv: "Google Contacts CSV",
  outlook_csv: "Outlook CSV",
  csv: "CSV",
};

export type ContactsFileRow = {
  fullName: string;
  firstName: string;
  lastName: string;
  company: string;
  title: string;
  email: string;
  phone: string;
  linkedinUrl: string;
  notes: string;
};

export type ContactsFileParseResult = {
  format: ContactsFileFormat;
  rows: ContactsFileRow[];
  warnings: string[];
};

/** A parse failure whose message is safe, and meant, to show the person who uploaded. */
export class ContactsFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContactsFileError";
  }
}

/**
 * The largest file the browser will even read.
 *
 * Deliberately far above `MAX_CONTACTS_FILE_CHARS`, because the raw file is not what gets
 * uploaded: an iCloud or Android export embeds every contact photo as base64, and a few hundred
 * photos is tens of megabytes of pixels around a few hundred kilobytes of names.
 * `compactContactsFileText` strips those in the browser before anything is sent, so this only
 * has to stop someone feeding `file.text()` something absurd.
 */
export const MAX_CONTACTS_FILE_BYTES = 50 * 1024 * 1024;

/**
 * The most text the server actions will parse — measured after `compactContactsFileText`.
 *
 * The file travels as a Server Action argument twice (preview, then confirm), and on Vercel a
 * function request body tops out around 4.5 MB whatever `serverActions.bodySizeLimit` says (see
 * `MAX_SUBMISSION_BYTES` in `src/lib/feedback-report.ts`). 3M characters leaves room for the
 * argument encoding's escaping and for multi-byte names, and is still ~10,000 photo-free
 * contacts — the same order as `MAX_CONTACTS_FILE_ROWS`, so neither limit is the one that
 * surprises anybody first.
 */
export const MAX_CONTACTS_FILE_CHARS = 3_000_000;

/**
 * Rows kept from one file; the rest are dropped with a warning rather than failing the file.
 *
 * Larger than any real personal address book, and far larger than `FREE_CONTACT_LIMIT` — the
 * plan cap is still enforced per row by the import engine, exactly as it is for LinkedIn and
 * the OAuth contact imports. This bounds the review list and the job rows, not the plan.
 */
export const MAX_CONTACTS_FILE_ROWS = 10_000;

/**
 * An address-book note is often a paragraph; it is occasionally a pasted email thread. The
 * contact's `notes` column is read by search and by the contact brief, so a runaway one is
 * trimmed rather than carried whole.
 */
const MAX_NOTE_CHARS = 4000;

/**
 * vCard properties whose values are binary blobs, never text a contact row could use. PHOTO is
 * the one that matters — it is routinely the bulk of an export — but LOGO, SOUND and KEY are
 * the same base64 shape and get the same treatment.
 */
const BINARY_PROPERTIES = new Set(["PHOTO", "LOGO", "SOUND", "KEY"]);

const VCARD_BEGIN = /^\s*BEGIN:VCARD\s*$/im;

/** Shared with the client, which checks the compacted text before uploading it (see `MAX_CONTACTS_FILE_CHARS`). */
export function contactsFileTooLargeMessage() {
  return `That file is too big to import in one go (the limit is about ${Math.round(
    MAX_CONTACTS_FILE_CHARS / 1_000_000
  )} MB of contact text) — split it into smaller exports and upload them one at a time`;
}

// ---------------------------------------------------------------------------------------------
// vCard: logical lines
// ---------------------------------------------------------------------------------------------

/**
 * One vCard property, after unfolding: every physical line it spanned, plus — unless it is a
 * binary property we are going to throw away — the joined text.
 *
 * Both are kept because the two callers want different things. The parser wants the unfolded
 * text; `compactContactsFileText` wants the original physical lines back, minus the ones that
 * belonged to a PHOTO, so the file it uploads is still the file the user chose.
 */
type LogicalLine = {
  physical: string[];
  unfolded: string;
  name: string;
  binary: boolean;
};

/** Index of the first `:` outside double quotes — v4 allows quoted parameter values, and those can contain one. */
function headerEnd(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ":" && !quoted) return i;
  }
  return -1;
}

/**
 * `item1.EMAIL;TYPE=work` -> `EMAIL`. The group prefix is how Apple ties a value to its custom
 * label (`item1.X-ABLabel`); nothing here reads labels, so the group is simply dropped.
 */
function propertyName(head: string): string {
  const semi = head.indexOf(";");
  const withGroup = semi === -1 ? head : head.slice(0, semi);
  const dot = withGroup.lastIndexOf(".");
  return (dot === -1 ? withGroup : withGroup.slice(dot + 1)).trim().toUpperCase();
}

/**
 * Group physical lines into properties, undoing both kinds of line wrapping vCard uses.
 *
 * RFC folding (every version): a line starting with a space or tab continues the previous one,
 * and exactly one leading whitespace character is removed.
 *
 * Quoted-printable soft breaks (2.1 only — Android and older Outlook still write it): a QP
 * value that ends in `=` continues on the next line, which need NOT be indented. Without this
 * the second half of every long QP name or note reads as a separate, unparseable property. The
 * `END:VCARD` guard is for exporters that leave a stray `=` on a card's last value; joining the
 * card terminator onto a name would swallow the next contact whole.
 *
 * A binary property is recorded but never joined, so a 200 KB photo costs one array of
 * references to substrings the split already made, not a 200 KB concatenation. In 2.1 a base64
 * value ends at a blank line, and some exporters don't indent its continuation lines at all;
 * both are absorbed into the binary property (base64 has no `:`, so an unindented chunk of it
 * can't be mistaken for a property).
 */
function vcardLogicalLines(text: string): LogicalLine[] {
  const out: LogicalLine[] = [];
  let current: LogicalLine | null = null;
  let currentIsQp = false;

  for (const line of text.split(/\r\n|\r|\n/)) {
    if (current) {
      if (
        currentIsQp &&
        current.unfolded.endsWith("=") &&
        !/^\s*END:VCARD\s*$/i.test(line)
      ) {
        current.physical.push(line);
        current.unfolded = current.unfolded.slice(0, -1) + line;
        continue;
      }
      if (line.startsWith(" ") || line.startsWith("\t")) {
        current.physical.push(line);
        if (!current.binary) current.unfolded += line.slice(1);
        continue;
      }
      if (current.binary && (line.trim() === "" || !line.includes(":"))) {
        current.physical.push(line);
        continue;
      }
      out.push(current);
    }

    const end = headerEnd(line);
    const head = end === -1 ? "" : line.slice(0, end);
    const name = end === -1 ? "" : propertyName(head);
    const binary = BINARY_PROPERTIES.has(name);
    current = { physical: [line], unfolded: binary ? "" : line, name, binary };
    currentIsQp = !binary && /QUOTED-PRINTABLE/i.test(head);
  }
  if (current) out.push(current);
  return out;
}

/**
 * The file text to upload: unchanged for a CSV, and for a vCard the same text with every
 * PHOTO/LOGO/SOUND/KEY property removed.
 *
 * Run in the browser before either server action sees the file. The parser skips those
 * properties anyway, so the rows are identical either way — this is purely about not shipping
 * megabytes of base64 across a request-size limit (see `MAX_CONTACTS_FILE_CHARS`) only for the
 * server to discard them. Because the server re-parses whatever it is sent, a client that
 * skipped this step changes nothing but the size of its own request.
 */
export function compactContactsFileText(text: string): string {
  const clean = text.replace(/^\uFEFF/, "");
  if (!VCARD_BEGIN.test(clean)) return clean;
  const kept: string[] = [];
  for (const logical of vcardLogicalLines(clean)) {
    if (!logical.binary) kept.push(...logical.physical);
  }
  return kept.join("\n");
}

// ---------------------------------------------------------------------------------------------
// vCard: property values
// ---------------------------------------------------------------------------------------------

type VCardParams = {
  types: string[];
  /** Lower is more preferred; `Infinity` when the property carries no preference at all. */
  rank: number;
  encoding: string;
  charset: string;
};

/** Split on `sep` outside double quotes. */
function splitUnquoted(value: string, sep: string): string[] {
  const parts: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === sep && !quoted) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

/**
 * Parameters in every dialect in circulation: 3.0's `TYPE=work,pref` and repeated
 * `TYPE=WORK;TYPE=PREF`, 4.0's `PREF=1` and quoted `TYPE="work,voice"`, and 2.1's bare
 * `EMAIL;INTERNET;PREF` / `;QUOTED-PRINTABLE`, where a parameter with no `=` is a type (or an
 * encoding) by position alone.
 */
function parseParams(head: string): VCardParams {
  const params: VCardParams = { types: [], rank: Infinity, encoding: "", charset: "" };
  let explicitPref: number | null = null;
  for (const raw of splitUnquoted(head, ";").slice(1)) {
    const eq = raw.indexOf("=");
    const key = (eq === -1 ? "" : raw.slice(0, eq)).trim().toUpperCase();
    const value = (eq === -1 ? raw : raw.slice(eq + 1)).trim().replace(/^"|"$/g, "");
    if (key === "TYPE" || key === "") {
      for (const t of value.split(",")) {
        const type = t.trim().toLowerCase();
        if (!type) continue;
        if (key === "" && (type === "quoted-printable" || type === "base64" || type === "b")) {
          params.encoding = type;
        } else {
          params.types.push(type);
        }
      }
    } else if (key === "PREF") {
      const n = Number.parseInt(value, 10);
      explicitPref = Number.isFinite(n) && n > 0 ? n : 1;
    } else if (key === "ENCODING") {
      params.encoding = value.toLowerCase();
    } else if (key === "CHARSET") {
      params.charset = value;
    }
  }
  params.rank = explicitPref ?? (params.types.includes("pref") ? 1 : Infinity);
  return params;
}

const utf8 = new TextEncoder();

/**
 * Quoted-printable to bytes. `=XX` is a byte; a lone trailing `=` is a soft break the line
 * joiner already consumed; anything else is literal. Bytes, not characters, because a 2.1
 * export encodes each UTF-8 byte of "José" separately (`Jos=C3=A9`) and only the charset
 * decode afterwards turns those two bytes back into one letter.
 */
function qpToBytes(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "=") {
      const hex = value.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
      }
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code < 0x80) bytes.push(code);
    else bytes.push(...utf8.encode(ch));
  }
  return Uint8Array.from(bytes);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Bytes to text in the card's declared charset, falling back to UTF-8 for a label the runtime doesn't know. */
function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/**
 * Undo a value's transfer encoding. Only 2.1 has one; for 3.0/4.0 this is the identity.
 *
 * `CHARSET` is honoured only alongside an encoding: an unencoded value has already been decoded
 * — as UTF-8, by `file.text()` in the browser — and there are no bytes left to reinterpret.
 */
function decodeTransfer(raw: string, params: VCardParams): string {
  if (params.encoding === "quoted-printable") {
    return decodeBytes(qpToBytes(raw), params.charset);
  }
  if (params.encoding === "b" || params.encoding === "base64") {
    try {
      return decodeBytes(base64ToBytes(raw), params.charset);
    } catch {
      return "";
    }
  }
  return raw;
}

/** vCard text escapes: `\n` is a newline, and `\,` `\;` `\\` (and Apple's `\:` in URLs) are the character itself. */
function unescapeText(value: string): string {
  return value.replace(/\\([\s\S])/g, (_, ch: string) => (ch === "n" || ch === "N" ? "\n" : ch));
}

/**
 * Split a structured value (`N`, `ORG`) on its unescaped semicolons. Done before unescaping —
 * `Doe\;Smith;Jane` is a family name with a semicolon in it, not three components — and before
 * transfer-decoding, since a QP-encoded `=3B` is data and only a literal `;` is structure.
 */
function splitComponents(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\" && i + 1 < raw.length) {
      current += ch + raw[i + 1];
      i++;
    } else if (ch === ";") {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function textValue(raw: string, params: VCardParams): string {
  return unescapeText(decodeTransfer(raw, params));
}

function componentValues(raw: string, params: VCardParams): string[] {
  return splitComponents(raw).map((part) => unescapeText(decodeTransfer(part, params)));
}

/** Collapse runs of whitespace — a QP name can decode with a newline in it. */
function tidy(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

type Ranked = { value: string; rank: number };

/** The most preferred candidate; ties (including "nobody said") go to the first one in the card. */
function preferred(candidates: Ranked[]): string {
  let best: Ranked | null = null;
  for (const c of candidates) {
    if (!best || c.rank < best.rank) best = c;
  }
  return best?.value ?? "";
}

function cleanEmail(value: string): string {
  const email = value.trim().replace(/^mailto:/i, "").trim();
  return email.includes("@") ? email : "";
}

/**
 * Prefer a profile (`/in/`) over any other LinkedIn URL a card lists — a company page is still
 * "a linkedin.com URL", and it would make every employee match each other as the same person.
 */
function pickLinkedIn(urls: string[]): string {
  const cleaned = urls
    .map((u) => u.trim())
    .filter((u) => /linkedin\.com/i.test(u))
    .map((u) => (/^https?:\/\//i.test(u) ? u : `https://${u.replace(/^\/+/, "")}`));
  return cleaned.find((u) => /linkedin\.com\/in\//i.test(u)) ?? cleaned[0] ?? "";
}

type CardDraft = {
  fn: string;
  n: string[] | null;
  org: string;
  title: string;
  emails: Ranked[];
  phones: Ranked[];
  urls: string[];
  note: string;
};

function emptyCard(): CardDraft {
  return { fn: "", n: null, org: "", title: "", emails: [], phones: [], urls: [], note: "" };
}

/**
 * Name precedence, the same for both file types: an explicit display name, then the
 * structured name assembled, then the email's local part. A card with none of those has
 * nothing to show in the review list or to match on, and is skipped.
 */
function rowFromParts(parts: {
  displayName: string;
  given: string;
  additional: string;
  family: string;
  company: string;
  title: string;
  email: string;
  phone: string;
  linkedinUrl: string;
  notes: string;
}): ContactsFileRow | null {
  const given = tidy(parts.given);
  const family = tidy(parts.family);
  const assembled = tidy([given, tidy(parts.additional), family].filter(Boolean).join(" "));
  const email = parts.email.trim();
  const fullName = tidy(parts.displayName) || assembled || (email ? email.split("@")[0] : "");
  if (!fullName) return null;
  return {
    fullName,
    firstName: given,
    lastName: family,
    company: tidy(parts.company),
    title: tidy(parts.title),
    email,
    phone: tidy(parts.phone),
    linkedinUrl: parts.linkedinUrl.trim(),
    notes: parts.notes.trim().slice(0, MAX_NOTE_CHARS),
  };
}

function finishCard(card: CardDraft): ContactsFileRow | null {
  // N is family;given;additional;prefix;suffix. Prefix and suffix are left out of the
  // assembled name on purpose — "Dr." makes a poor first word to match or sort on.
  const [family = "", given = "", additional = ""] = card.n ?? [];
  return rowFromParts({
    displayName: card.fn,
    given,
    additional,
    family,
    company: card.org,
    title: card.title,
    email: preferred(card.emails),
    phone: preferred(card.phones),
    linkedinUrl: pickLinkedIn(card.urls),
    notes: card.note,
  });
}

function parseVCards(text: string): { rows: ContactsFileRow[]; cards: number; unnamed: number } {
  const rows: ContactsFileRow[] = [];
  let card: CardDraft | null = null;
  // 2.1's AGENT property can embed a whole second vCard inline. Its lines belong to that
  // other person, so everything below the outermost card is ignored rather than merged in.
  let depth = 0;
  let cards = 0;
  let unnamed = 0;

  for (const logical of vcardLogicalLines(text)) {
    if (logical.binary) continue;
    const line = logical.unfolded;
    const end = headerEnd(line);
    if (end === -1) continue;
    const head = line.slice(0, end);
    const raw = line.slice(end + 1);
    const name = logical.name;

    if (name === "BEGIN" && /^\s*vcard\s*$/i.test(raw)) {
      depth++;
      if (depth === 1) card = emptyCard();
      continue;
    }
    if (name === "END" && /^\s*vcard\s*$/i.test(raw)) {
      if (depth === 1 && card) {
        cards++;
        const row = finishCard(card);
        if (row) rows.push(row);
        else unnamed++;
        card = null;
      }
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (!card || depth !== 1) continue;

    const params = parseParams(head);
    switch (name) {
      case "FN":
        if (!card.fn) card.fn = tidy(textValue(raw, params));
        break;
      case "N":
        if (!card.n) card.n = componentValues(raw, params);
        break;
      case "ORG":
        // First component is the organization; the rest are departments.
        if (!card.org) card.org = componentValues(raw, params)[0] ?? "";
        break;
      case "TITLE":
        if (!card.title) card.title = textValue(raw, params);
        break;
      case "EMAIL": {
        const email = cleanEmail(textValue(raw, params));
        if (email) card.emails.push({ value: email, rank: params.rank });
        break;
      }
      case "TEL": {
        // 4.0 may write `TEL;VALUE=uri:tel:+1-555-0100`.
        const phone = textValue(raw, params).trim().replace(/^tel:/i, "").trim();
        if (phone) card.phones.push({ value: phone, rank: params.rank });
        break;
      }
      case "URL":
      case "X-SOCIALPROFILE":
        card.urls.push(textValue(raw, params));
        break;
      case "NOTE":
        if (!card.note) card.note = textValue(raw, params);
        break;
    }
  }

  return { rows, cards, unnamed };
}

// ---------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------

/**
 * Header names, lowercased, by field. Google's current export, Google's older export, Outlook
 * (desktop and Outlook.com) and a plain hand-made sheet all fit in these lists; the first
 * present column with a value wins, so each list is in order of trust.
 *
 * `title` deliberately has no bare "title": in an Outlook CSV that column is the honorific
 * (Mr., Dr.), and the job lives in "Job Title". A generic CSV's "Title" is accepted
 * separately, only when the file is not Outlook's.
 */
const CSV_FIELDS = {
  fullName: ["name", "full name", "display name", "contact name"],
  firstName: ["first name", "given name", "firstname", "first"],
  middleName: ["middle name", "additional name"],
  lastName: ["last name", "family name", "surname", "lastname", "last"],
  company: [
    "organization name",
    "organization 1 - name",
    "company",
    "company name",
    "organization",
    "employer",
  ],
  title: ["organization title", "organization 1 - title", "job title", "position"],
  email: [
    "e-mail address",
    "email address",
    "email",
    "e-mail",
    "e-mail 2 address",
    "e-mail 3 address",
    "email 2",
  ],
  phone: [
    "primary phone",
    "mobile phone",
    "business phone",
    "home phone",
    "other phone",
    "business phone 2",
    "home phone 2",
    "company main phone",
    "phone",
    "phone number",
    "mobile",
    "mobile number",
    "cell",
    "cell phone",
    "telephone",
    "work phone",
  ],
  notes: ["notes", "note"],
} as const;

/** Headers a LinkedIn Connections export carries; "connected on" is the one nothing else has. */
function looksLikeLinkedInConnections(head: string) {
  return head.includes("first name") && head.includes("last name") && head.includes("connected on");
}

function looksLikeLinkedInMessages(head: string) {
  return head.includes("conversation id") && head.includes("conversation title");
}

type HeaderIndex = Map<string, string>;

function headerIndex(fields: string[]): HeaderIndex {
  const index: HeaderIndex = new Map();
  for (const field of fields) {
    const key = field.trim().toLowerCase();
    if (key && !index.has(key)) index.set(key, field);
  }
  return index;
}

/**
 * Google writes several values into one cell as `a@x.com ::: b@y.com`; the first is the one
 * the contact lists first.
 */
function firstMultiValue(value: string): string {
  return value.split(":::")[0].trim();
}

function cell(row: Record<string, string>, index: HeaderIndex, keys: readonly string[]): string {
  for (const key of keys) {
    const header = index.get(key);
    const value = header ? row[header]?.trim() : "";
    if (value) return value;
  }
  return "";
}

type NumberedColumn = { value: string; label: string | undefined };

/**
 * Google's numbered `E-mail N - Value` / `Phone N - Value` columns, each paired with the label
 * column beside it (`E-mail N - Label` today, `- Type` in the older export). Resolved once per
 * file rather than per row: the header is the same for all ten thousand of them.
 */
function numberedColumns(fields: string[], kind: "e-mail" | "phone"): NumberedColumn[] {
  const pattern = new RegExp(`^${kind} (\\d+) - value$`, "i");
  const columns: NumberedColumn[] = [];
  for (const field of fields) {
    const match = field.trim().match(pattern);
    if (!match) continue;
    const labelPattern = new RegExp(`^${kind} ${match[1]} - (label|type)$`, "i");
    columns.push({ value: field, label: fields.find((f) => labelPattern.test(f.trim())) });
  }
  return columns;
}

/**
 * A row's values from its numbered columns. A label starting with `*` marks the value the
 * contact chose as primary — the CSV spelling of vCard's `TYPE=pref`.
 */
function numberedValues(
  row: Record<string, string>,
  columns: NumberedColumn[],
  clean: (value: string) => string
): Ranked[] {
  const out: Ranked[] = [];
  for (const column of columns) {
    const value = clean(firstMultiValue(row[column.value] ?? ""));
    if (!value) continue;
    const primary = column.label ? (row[column.label] ?? "").trim().startsWith("*") : false;
    out.push({ value, rank: primary ? 1 : Infinity });
  }
  return out;
}

function csvFormat(index: HeaderIndex): ContactsFileFormat {
  const has = (key: string) => index.has(key);
  if (
    has("e-mail 1 - value") ||
    has("phone 1 - value") ||
    has("organization name") ||
    has("organization 1 - name") ||
    has("given name")
  ) {
    return "google_csv";
  }
  if (has("e-mail address") || has("business phone") || has("primary phone") || has("job title")) {
    return "outlook_csv";
  }
  return "csv";
}

function parseContactsCsv(text: string): {
  format: ContactsFileFormat;
  rows: ContactsFileRow[];
  unnamed: number;
  malformed: number;
} {
  const head = text.slice(0, 5000).toLowerCase();
  if (looksLikeLinkedInConnections(head)) {
    throw new ContactsFileError(
      "This looks like a LinkedIn Connections export — upload it on the LinkedIn connections card, which keeps each person’s profile link and when you connected"
    );
  }
  if (looksLikeLinkedInMessages(head)) {
    throw new ContactsFileError(
      "This looks like a LinkedIn Messages export — upload it on the Messages tab instead"
    );
  }

  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  const fields = (parsed.meta.fields ?? []).filter((f) => f.trim());
  const index = headerIndex(fields);
  const format = csvFormat(index);

  const emailColumns = numberedColumns(fields, "e-mail");
  const phoneColumns = numberedColumns(fields, "phone");
  const recognised =
    emailColumns.length > 0 ||
    [...CSV_FIELDS.fullName, ...CSV_FIELDS.firstName, ...CSV_FIELDS.lastName, ...CSV_FIELDS.email].some(
      (key) => index.has(key)
    );
  if (!recognised) {
    const found = fields.length
      ? ` (it has ${fields.slice(0, 6).join(", ")}${fields.length > 6 ? "…" : ""})`
      : "";
    throw new ContactsFileError(
      `Couldn’t find name or email columns in that file${found} — upload a vCard (.vcf), or a CSV exported from Google Contacts or Outlook`
    );
  }

  const titleKeys: readonly string[] =
    format === "csv" ? [...CSV_FIELDS.title, "title"] : CSV_FIELDS.title;
  const urlHeaders = fields.filter((f) => /web ?site|web page|url|linkedin|profile/i.test(f));

  const rows: ContactsFileRow[] = [];
  let unnamed = 0;
  for (const record of parsed.data) {
    // Numbered (Google) columns first, then the named ones (Outlook, a hand-made sheet). A
    // file only ever has one kind, so the order only matters for how ties are broken.
    const emails = numberedValues(record, emailColumns, cleanEmail);
    const plainEmail = cleanEmail(firstMultiValue(cell(record, index, CSV_FIELDS.email)));
    if (plainEmail) emails.push({ value: plainEmail, rank: Infinity });
    const phones = numberedValues(record, phoneColumns, (v) => v.trim());
    const plainPhone = firstMultiValue(cell(record, index, CSV_FIELDS.phone));
    if (plainPhone) phones.push({ value: plainPhone, rank: Infinity });

    const row = rowFromParts({
      displayName: cell(record, index, CSV_FIELDS.fullName),
      given: cell(record, index, CSV_FIELDS.firstName),
      additional: cell(record, index, CSV_FIELDS.middleName),
      family: cell(record, index, CSV_FIELDS.lastName),
      company: cell(record, index, CSV_FIELDS.company),
      title: cell(record, index, titleKeys),
      email: preferred(emails),
      phone: preferred(phones),
      linkedinUrl: pickLinkedIn(urlHeaders.map((h) => record[h] ?? "")),
      notes: cell(record, index, CSV_FIELDS.notes),
    });
    if (row) rows.push(row);
    else unnamed++;
  }

  // Papa reports rows whose field count doesn't match the header, but still returns them —
  // it's a warning about this file's shape, not rows that went missing.
  const malformed = new Set(parsed.errors.map((e) => e.row)).size;
  return { format, rows, unnamed, malformed };
}

// ---------------------------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------------------------

function nameKey(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Collapse contacts that appear more than once in the same file — common, because exports
 * overlap (an iCloud export of a phone that also syncs Google lists everyone twice).
 *
 * Two rows are the same person when they share an email, or share a name and a phone number.
 * Not a name alone: the duplicate matcher treats a bare name as a question, not an answer (see
 * `DUPLICATE_MERGE_CONFIDENCE`), and so does this. Not a role address either (`info@`, `sales@`)
 * — three colleagues listed under the office inbox are three people, which is the same call
 * `isRoleEmail` makes for `contact_identities`.
 *
 * The first occurrence is kept and its blanks are filled from the later ones, so a sparse card
 * and a detailed card for one person import as the detailed one.
 */
function dedupeRows(rows: ContactsFileRow[]): { rows: ContactsFileRow[]; merged: number } {
  const kept: ContactsFileRow[] = [];
  const byEmail = new Map<string, number>();
  const byNamePhone = new Map<string, number>();
  let merged = 0;

  const keysOf = (row: ContactsFileRow) => {
    const email = row.email.toLowerCase();
    const digits = row.phone.replace(/\D/g, "");
    return {
      email: email && !isRoleEmail(email) ? email : "",
      namePhone: digits.length >= 5 ? `${nameKey(row.fullName)}|${digits}` : "",
    };
  };

  for (const row of rows) {
    const keys = keysOf(row);
    const existing =
      (keys.email ? byEmail.get(keys.email) : undefined) ??
      (keys.namePhone ? byNamePhone.get(keys.namePhone) : undefined);

    if (existing === undefined) {
      const at = kept.push({ ...row }) - 1;
      if (keys.email) byEmail.set(keys.email, at);
      if (keys.namePhone) byNamePhone.set(keys.namePhone, at);
      continue;
    }

    merged++;
    const target = kept[existing];
    for (const field of Object.keys(target) as (keyof ContactsFileRow)[]) {
      if (!target[field] && row[field]) target[field] = row[field];
    }
    // The survivor may have just gained an email or phone it didn't have; index those too so
    // a third copy keyed on them still lands here.
    const next = keysOf(target);
    if (next.email && !byEmail.has(next.email)) byEmail.set(next.email, existing);
    if (next.namePhone && !byNamePhone.has(next.namePhone)) byNamePhone.set(next.namePhone, existing);
  }

  return { rows: kept, merged };
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Parse an uploaded address-book file into import rows.
 *
 * `fileName` is only a hint for the error message: detection is by content, because exports
 * are routinely renamed, and a `.csv` that is actually a vCard (or the reverse) should still
 * import.
 */
export function parseContactsFile(text: string, fileName = ""): ContactsFileParseResult {
  const clean = text.replace(/^\uFEFF/, "");
  if (!clean.trim()) throw new ContactsFileError("That file is empty");
  if (clean.length > MAX_CONTACTS_FILE_CHARS) {
    throw new ContactsFileError(contactsFileTooLargeMessage());
  }

  const warnings: string[] = [];
  let format: ContactsFileFormat;
  let parsedRows: ContactsFileRow[];
  let unnamed: number;

  if (VCARD_BEGIN.test(clean)) {
    const result = parseVCards(clean);
    if (result.cards === 0) {
      throw new ContactsFileError("No contacts found in that vCard file");
    }
    if (result.rows.length === 0) {
      throw new ContactsFileError(
        `None of the ${plural(result.cards, "contact", "contacts")} in that file had a name or an email address`
      );
    }
    format = "vcard";
    parsedRows = result.rows;
    unnamed = result.unnamed;
  } else if (/\.(vcf|vcard)$/i.test(fileName.trim())) {
    throw new ContactsFileError(
      "That file doesn’t contain any vCards — export your contacts again as a vCard (.vcf) and upload that"
    );
  } else {
    const result = parseContactsCsv(clean);
    if (result.rows.length === 0) {
      throw new ContactsFileError("No contacts with a name or email address found in that file");
    }
    format = result.format;
    parsedRows = result.rows;
    unnamed = result.unnamed;
    if (result.malformed > 0) {
      warnings.push(
        `${plural(result.malformed, "row", "rows")} in the CSV had the wrong number of columns — check those people after importing.`
      );
    }
  }

  if (unnamed > 0) {
    warnings.push(
      `${plural(unnamed, "contact", "contacts")} had no name or email address and ${unnamed === 1 ? "was" : "were"} skipped.`
    );
  }

  const { rows: deduped, merged } = dedupeRows(parsedRows);
  if (merged > 0) {
    warnings.push(
      `Combined ${plural(merged, "duplicate entry", "duplicate entries")} — some people are listed more than once in this file.`
    );
  }

  let rows = deduped;
  if (rows.length > MAX_CONTACTS_FILE_ROWS) {
    warnings.push(
      `Only the first ${MAX_CONTACTS_FILE_ROWS.toLocaleString("en-US")} of ${rows.length.toLocaleString("en-US")} contacts were read. Split the export to import the rest.`
    );
    rows = rows.slice(0, MAX_CONTACTS_FILE_ROWS);
  }

  // U+FFFD is what a UTF-8 decode leaves where a byte didn't fit — the signature of a
  // Windows-1252 Outlook CSV read as UTF-8 by `file.text()`.
  if (rows.some((r) => [r.fullName, r.company, r.title, r.notes].some((v) => v.includes("\uFFFD")))) {
    warnings.push(
      "Some characters may not have decoded correctly — if names look garbled, export the file again as UTF-8, or as a vCard."
    );
  }

  return { format, rows, warnings };
}
