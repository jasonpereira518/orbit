# Relationship Engine P2 — WhatsApp & iMessage Chat Imports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person upload WhatsApp and iMessage chat exports so the P1 relationship engine reads those conversations too: browser-side parsing, a preview that links each conversation to the right contact, chunked staging onto the resumable import engine, one `interactions` row per chat session, and the whole feature dark behind `feature.chat-imports` until the privacy disclosure ships.

**Architecture:**
- **Parsing in the browser.** Pure parsers (`src/lib/conversations/`) turn a `.txt` or `.zip` export into a normalized `Conversation`. Nothing but text leaves the browser: media is never read and message bodies never go up in the preview.
- **Preview resolves identities.** A server action resolves who each participant is against compact summaries (names, phones, emails, counts). It returns candidates and auto-links confident matches. The user picks for the rest, says which sender is them (WhatsApp), and ticks group members to add.
- **Chunked staging.** The client stages conversations in ~1.5 MB batches (`beginChatImport` → `appendChatRows` × N → `startChatImport`). The engine then runs a new chat adapter, which honours a preview-pinned contact through a new optional `resolvedContactId` adapter hook.
- **Session rows.** Each session becomes one `interactions` row per matched contact (`interaction_type 'message'`, `source 'whatsapp' | 'imessage'`). P1's pending predicate already reads those, so `finalize` only kicks the relationship runner.

**Tech Stack:** Next.js App Router (read `node_modules/next/dist/docs/` before touching routes/actions, per AGENTS.md), Drizzle (neon-http in prod, PGlite locally), zod, `jszip` (already a dependency, dynamic import only), `tsx` smoke scripts registered in `scripts/run-smoke.ts`.

**Spec:** `docs/superpowers/specs/2026-09-30-relationship-engine-design.md`, §2 (parsers, identity, sessions), §6 Upload, §7 (privacy/dark release), §8 (smokes). P1 plan for context: `docs/superpowers/plans/2026-09-30-relationship-engine-p1-core.md`.

**Branch:** stack on P1. Create `claude/relationship-engine-p2-chat-imports` from `claude/contact-relationship-engine-ada98f` (PR #398, head `e6bc22a5`). The PR targets `claude/contact-relationship-engine-ada98f` until #398 merges, then retarget it to `main` (`gh pr edit <n> --base main`; the repo does not auto-retarget).

## Global Constraints

- Every smoke script starts with `import "./smoke/_env";` and is registered in `MANIFEST` in `scripts/run-smoke.ts` (`pure` or `pglite`). PGlite scripts use their own user ids, delete their own rows first, and end with `process.exit(0)`.
- **Parsers and session code are pure and browser-safe:** no `@/db`, no `node:*`, no `next/*` imports anywhere under `src/lib/conversations/` (a client bundle reaching `@/db` fails the build).
- **Media is never read:** the zip reader opens only `.txt` members; no `async()` on any other member.
- Sessions: a new session starts after a gap **> 6 hours**; a session is capped at **200 messages** or **12,000 characters** (split at the cap).
- Session row: `interaction_type 'message'`, `source 'whatsapp' | 'imessage'`, **`interaction_date` = the session's LAST message time** (so a session that grows on re-export moves past the watermark and is re-read), `external_id = chat:<source>:<conversationKey>:<sessionStartEpochSeconds>:<contactId>`, `raw_notes` = transcript lines `[YYYY-MM-DD HH:MM Name] text` (group sessions prefixed with one header line), `ai_summary` = first 240 chars of the transcript, `direction` = direction of the session's last message (`"out"` when the sender is the owner, `"in"` otherwise, `null` when the owner is unknown).
- Groups: analyzed only for members the user linked to an existing contact or explicitly ticked "add as contact". **Unmatched group members are never auto-created.** A 1:1 conversation with no match creates its contact.
- Identity: every created contact gets its identifiers through `toCreate` (`phone` normalized to E.164 by the same rule as `normalizePhone` in `src/lib/duplicates.ts`, `email`). The owner is never a contact: preview filters participants with `isSelf` (`src/lib/meeting-digest.ts`) and the saved self names.
- Feature gate: everything user-visible and every new server action is behind surface **`feature.chat-imports`** (`comingSoon: true`). The server actions refuse unless `isSurfaceLive(userId, "feature.chat-imports")`.
- New AI spend: none in this plan beyond the P1 engine. The preview cost estimate uses `estimateCostMicros` + `getAiConfig(userId, "relationship.digest")`; with no usable key the estimate is `null` and the UI says to add a key.
- **`SCHEMA_VERSION` = 148** (147 is P1, unmerged). Re-scan every remote ref AND `git worktree list` before the PR; take one above the highest found. A DDL change needs `npx tsx scripts/smoke-schema-ddl.ts --update` and `npm run db:check`.
- Server actions return client-facing errors through the existing `refusal(...)` data pattern used in `src/actions/imports.ts` (a thrown message does not survive production). Toast/refusal copy has no trailing period (`smoke-toast-copy`).
- "use server" files export only async functions.
- Commit after each task; message trailer `Co-Authored-By: <your model> <noreply@anthropic.com>`.

## Decisions made while planning (flag at handoff)

1. **Dedicated "Chat messages" card on `/imports`, not the generic drop queue.** The queue keeps one file per target and classifies CSV headers. A chat import is many files, one per conversation. Task 11 adds a light hand-off: `.txt`/WhatsApp-`.zip` files dropped on the page are routed to the chat card instead of becoming a queue target. Spec §6 says "the existing drop zone and queue recognize…" — this satisfies the recognition, not the shared queue UI.
2. **New adapter hook `resolvedContactId?(payload)`.** The engine's matcher has no phone tier, and a name-only WhatsApp chat scores at most 0.60 (never folds). The preview's picker result is carried in the payload and honoured by the engine. This is the spec's "picker", made enforceable.
3. **Session `interaction_date` = last message time** (not first, as spec §2 wrote), so a session that grows when the chat is re-exported becomes pending again. The external id keeps the start time, so the row upserts in place.
4. **Staging status `"staging"`.** The `imports` row is created as `status: "staging"` so the stall cron (`import-stall.ts` reads `status = 'processing'`) never runs a half-staged job. `startChatImport` flips it to `"processing"`. A sweep deletes `staging` rows older than 24 h.
5. **`feature` surface kind added fresh** (`SurfaceKind` gains `"feature"`). The unmerged direct-email branches (#379/#382/#388) add the same kind with `feature.compose`/`feature.outlook-send`. Whichever merges second keeps ONE `FEATURES` array and one admin section.
6. **Chat rows are typed `'message'`.** LinkedIn-keyed code paths (closeness cohort's message counts, Radar's unanswered-inbound signal, the direction partial index) do not read them in P2. Recency still flows through `lastInteractionAt` (merge widening). Listed as a P3 follow-up.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/conversations/types.ts` | `Conversation`, `ChatMessage`, `ChatParticipant`, `ChatSession`, `ChatSource`, limits, `MAX_APPEND_ROWS` |
| `src/lib/conversations/hash.ts` | `fnv1a64(text)` — tiny sync hash usable in browser and Node |
| `src/lib/conversations/phone.ts` | `normalizePhoneLoose` — browser-safe twin of `normalizePhone` |
| `src/lib/conversations/whatsapp.ts` | `parseWhatsAppExport(text, fileName, opts)` |
| `src/lib/conversations/imessage.ts` | `parseIMessageExport(text, fileName)` |
| `src/lib/conversations/sessions.ts` | `splitSessions`, `conversationKey`, `sessionExternalId`, `groupHeader` |
| `src/lib/conversations/read-files.ts` | Browser: `File[]` → `{fileName, text, source}[]` (zip `.txt` members only), detection |
| `src/lib/conversations/to-rows.ts` | Pure: `Conversation` + preview decisions → `ChatConversationRowPayload[]` |
| `src/db/schema.ts`, `src/db/index.ts` | `ChatConversationRowPayload` in the payload union; `user_settings.chat_self_names`; v148 |
| `src/lib/import-engine.ts` | `resolvedContactId` hook |
| `src/lib/import-adapters/chat.ts` | `WHATSAPP_CHAT_IMPORT_TYPE`, `IMESSAGE_CHAT_IMPORT_TYPE`, `chatAdapter(source)` |
| registration points (Task 5) | adapter index, dispatch, source labels, history icons, admin labels |
| `src/lib/surfaces.ts` (+ admin product page) | `"feature"` kind, `feature.chat-imports` |
| `src/lib/chat-import-preview.ts` | Server-only preview matching, self filter, estimate, staging helpers |
| `src/actions/chat-imports.ts` | `previewChatConversations`, `beginChatImport`, `appendChatRows`, `startChatImport` |
| `src/lib/import-job-runner.ts` | `kind: "chat"` job: begin → append batches → start → poll |
| `src/components/imports/chat-messages-import.tsx` (+ `chat-conversation-review.tsx`) | The card: pick files, parse, "which sender is you", review, estimate, start |
| `src/components/imports/import-hub.tsx`, `import-dropzone.tsx`, `src/lib/imports/detect-import-file.ts`, `src/lib/imports/chat-handoff.ts` | Mount behind the flag; `.txt` accepted; dropped chat files routed to the card |
| `src/lib/relationship-engine/gather.ts`, `extract.ts` | Newest-rows read; session speaker; group attribution rule |
| `scripts/smoke-chat-*.ts`, eval fixtures | Tests |

---

### Task 1: Conversation types, hash, phone rule, and the WhatsApp parser

**Files:**
- Create: `src/lib/conversations/types.ts`, `hash.ts`, `phone.ts`, `whatsapp.ts`
- Create: `scripts/smoke-chat-parsers.ts`; register `"smoke-chat-parsers": "pure"`

**Interfaces:**
- Produces: the types below; `fnv1a64(text: string): string`; `normalizePhoneLoose(value: string): string | null`; `parseWhatsAppExport(text: string, fileName: string, opts?: { localeDayFirst?: boolean }): Conversation`; exported `WHATSAPP_LINE_RE`.

- [ ] **Step 1: Write `types.ts` and `hash.ts`** (consumed by every later task)

```ts
// src/lib/conversations/types.ts
/**
 * A chat export, normalized. Pure data — this module and everything under
 * src/lib/conversations/ runs in the browser: no @/db, node:*, or next/* imports.
 */
export type ChatSource = "whatsapp" | "imessage";

export type ChatParticipant = {
  /** Stable within one conversation: the sender label exactly as the export spells it. */
  key: string;
  displayName: string;
  phoneE164: string | null;
  email: string | null;
  isSelf: boolean;
};

export type ChatMessage = {
  senderKey: string;
  /** ISO 8601. Export times carry no zone; they are read as the browser's local time. */
  at: string;
  text: string;
};

export type Conversation = {
  source: ChatSource;
  fileName: string;
  /** iMessage: from the file name. WhatsApp: from "WhatsApp Chat with X.txt", else the other sender. */
  title: string;
  isGroup: boolean;
  participants: ChatParticipant[];
  /** Oldest first. */
  messages: ChatMessage[];
  /** True when day/month order could not be proven from the file and the locale decided. */
  dateOrderGuessed: boolean;
  /** Lines that looked like messages but could not be read. */
  skippedLines: number;
};

export type ChatSession = {
  startAt: string;
  endAt: string;
  messageCount: number;
  /** Direction of the LAST message: "out" from the owner, "in" otherwise, null if the owner is unknown. */
  direction: "in" | "out" | null;
  transcript: string;
};

export const SESSION_GAP_MS = 6 * 60 * 60 * 1000;
export const SESSION_MAX_MESSAGES = 200;
export const SESSION_MAX_CHARS = 12_000;
/** Rows per appendChatRows call; client batching and the server cap share it. */
export const MAX_APPEND_ROWS = 200;
```

```ts
// src/lib/conversations/hash.ts
/** FNV-1a 64-bit, hex. Sync and dependency-free so the browser and Node compute the same key. */
export function fnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}
```
(If `tsconfig`'s `target` rejects BigInt literals, use `BigInt("0xcbf29ce484222325")` forms.)

`src/lib/conversations/phone.ts` — **before writing, read `normalizePhone` in `src/lib/duplicates.ts` (~line 118) and reproduce its exact rules** (it cannot be imported into the browser). Starting point, to be corrected to match it:
```ts
/**
 * E.164 for a phone-looking sender label, or null. Browser-safe twin of normalizePhone in
 * src/lib/duplicates.ts — scripts/smoke-chat-parsers.ts asserts the two agree.
 */
export function normalizePhoneLoose(value: string): string | null {
  const v = value.trim();
  if (!/^[+\d][\d\s().-]{6,}$/.test(v)) return null;
  const digits = v.replace(/\D/g, "");
  if (v.startsWith("+") && digits.length >= 7 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return null;
}
```

- [ ] **Step 2: Write the failing smoke (WhatsApp half)**

```ts
/**
 * Chat export parsers. Fixtures are written inline in the shapes the apps produce.
 * Run: npx tsx scripts/smoke-chat-parsers.ts
 */
import "./smoke/_env";
import { parseWhatsAppExport } from "../src/lib/conversations/whatsapp";
import { fnv1a64 } from "../src/lib/conversations/hash";
import { normalizePhoneLoose } from "../src/lib/conversations/phone";
import { normalizePhone } from "../src/lib/duplicates";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

check("hash: stable", fnv1a64("abc") === fnv1a64("abc") && fnv1a64("abc") !== fnv1a64("abd"));
check("hash: 16 hex chars", /^[0-9a-f]{16}$/.test(fnv1a64("x")));
for (const p of ["+1 (415) 555-0134", "415-555-0134", "14155550134", "+44 20 7946 0958", "12345", "Maya"]) {
  check(`phone twin agrees: ${p}`, (normalizePhoneLoose(p) ?? "") === normalizePhone(p), `${normalizePhoneLoose(p)} vs ${normalizePhone(p)}`);
}

// iOS, day-first (13 proves it), seconds, LRM marks, multi-line, media + system lines.
const ios = [
  "[13/03/2024, 09:15:02] Messages and calls are end-to-end encrypted. No one outside of this chat can read them.",
  "[13/03/2024, 09:15:02] Maya Chen: Hey! Are you free next Tuesday?",
  "[13/03/2024, 09:16:40] Jason Pereira: Yes — lunch at 1?",
  "Also bring the deck",
  "[13/03/2024, 09:17:05] Maya Chen: ‎image omitted",
  "[13/03/2024, 09:18:00] Maya Chen: This message was deleted",
  "[14/03/2024, 18:00:00] Maya Chen: Perfect, see you then",
].join("\n");
const a = parseWhatsAppExport(ios, "WhatsApp Chat with Maya Chen.txt", { localeDayFirst: false });
check("ios: title from file name", a.title === "Maya Chen");
check("ios: 1:1", a.isGroup === false && a.participants.length === 2);
check("ios: system + media + deleted dropped", a.messages.length === 3, JSON.stringify(a.messages.map((m) => m.text)));
check("ios: continuation joined", a.messages[1].text === "Yes — lunch at 1?\nAlso bring the deck");
check("ios: day-first proven", a.dateOrderGuessed === false && new Date(a.messages[0].at).getDate() === 13);

// Android, 12-hour with narrow no-break space, month-first (second field 13 proves it).
const android = [
  "3/13/24, 2:05 PM - Diego: Can you intro me to Priya?",
  "3/13/24, 2:07 PM - You: Sure, Friday",
  "3/14/24, 9:00 AM - Diego: Thanks!",
].join("\n");
const b = parseWhatsAppExport(android, "WhatsApp Chat with Diego.txt");
check("android: 3 messages", b.messages.length === 3);
check("android: month-first proven", new Date(b.messages[0].at).getDate() === 13);
check("android: PM to 24h", new Date(b.messages[0].at).getHours() === 14);
check("android: 'You' is self", b.participants.find((p) => p.key === "You")?.isSelf === true);

// Ambiguous dates (all fields <= 12) → locale decides, flagged.
const amb = "01/02/2024, 10:00 - Sam: hi there\n01/02/2024, 10:01 - Ana: hello";
const c1 = parseWhatsAppExport(amb, "chat.txt", { localeDayFirst: true });
const c2 = parseWhatsAppExport(amb, "chat.txt", { localeDayFirst: false });
check("ambiguous: flagged", c1.dateOrderGuessed && c2.dateOrderGuessed);
check("ambiguous: day-first → 1 Feb", new Date(c1.messages[0].at).getMonth() === 1);
check("ambiguous: month-first → 2 Jan", new Date(c2.messages[0].at).getMonth() === 0);

// Group: > 2 distinct senders; raw phone sender becomes phoneE164; "added" notice dropped.
const group = [
  "13/03/2024, 10:00 - Ana: Welcome everyone",
  "13/03/2024, 10:01 - +1 (415) 555-0134: Hi all",
  "13/03/2024, 10:02 - Ben: hey",
  "13/03/2024, 10:03 - Ana added Carla",
].join("\n");
const g = parseWhatsAppExport(group, "WhatsApp Chat with Founders Club.txt");
check("group: detected", g.isGroup === true && g.title === "Founders Club");
check("group: phone sender normalized", g.participants.some((p) => p.phoneE164 === "+14155550134"));
check("group: 'added' notice dropped", g.messages.length === 3);

const junk = parseWhatsAppExport("hello world\nnot a chat", "notes.txt");
check("junk: empty, not thrown", junk.messages.length === 0);

console.log("\nsmoke-chat-parsers: all checks passed");
```

- [ ] **Step 3: Run it to verify it fails** — `npx tsx scripts/smoke-chat-parsers.ts` → module not found.

- [ ] **Step 4: Implement `whatsapp.ts`**

```ts
/**
 * WhatsApp "Export chat" text. Two families of line, each in 12/24-hour and locale variants:
 *   iOS:     [13/03/2024, 09:15:02] Maya Chen: text
 *   Android: 13/03/2024, 09:15 - Maya Chen: text
 * A line that does not start with a timestamp continues the previous message. Lines without
 * "Name: " after the timestamp are system notices and are dropped, as are media/deleted stubs.
 * Day/month order is decided per file: any first field > 12 → day-first; any second field > 12
 * → month-first; otherwise the caller's locale decides and the result is flagged.
 */
import { normalizePhoneLoose } from "@/lib/conversations/phone";
import type { ChatMessage, ChatParticipant, Conversation } from "@/lib/conversations/types";

export const WHATSAPP_LINE_RE =
  /^[‎‏]?\[?(\d{1,2})[/.](\d{1,2})[/.](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[\s  ]*([AaPp])\.?\s?[Mm]\.?)?\]?\s*(?:-\s)?(.*)$/;
const SENDER_RE = /^([^:]{1,80}):\s([\s\S]*)$/;
const DROP_BODY_RE =
  /^[‎‏]?(?:<Media omitted>|<attached: .*>|(?:image|video|audio|sticker|GIF|document|Contact card) omitted|This message was deleted|You deleted this message|Missed (?:voice|video) call|null)$/i;
const SELF_LABELS = new Set(["you", "me"]);

type Raw = { d1: number; d2: number; y: number; h: number; mi: number; s: number; ampm: string | null; rest: string };

function titleFromFileName(fileName: string): string | null {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.(txt|zip)$/i, "");
  const m = base.match(/^WhatsApp Chat (?:with|-)\s*(.+)$/i);
  return m ? m[1].trim() : null;
}

export function parseWhatsAppExport(
  text: string,
  fileName: string,
  opts: { localeDayFirst?: boolean } = {}
): Conversation {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const raws: Raw[] = [];
  let skippedLines = 0;
  for (const line of lines) {
    const m = line.match(WHATSAPP_LINE_RE);
    if (m) {
      raws.push({
        d1: Number(m[1]), d2: Number(m[2]), y: Number(m[3]), h: Number(m[4]), mi: Number(m[5]),
        s: m[6] ? Number(m[6]) : 0, ampm: m[7] ? m[7].toLowerCase() : null, rest: m[8] ?? "",
      });
    } else if (raws.length && line.trim()) {
      raws[raws.length - 1].rest += `\n${line}`;
    } else if (line.trim()) {
      skippedLines += 1;
    }
  }

  let dayFirst: boolean;
  let dateOrderGuessed = false;
  if (raws.some((r) => r.d1 > 12)) dayFirst = true;
  else if (raws.some((r) => r.d2 > 12)) dayFirst = false;
  else {
    dayFirst = opts.localeDayFirst ?? true;
    dateOrderGuessed = raws.length > 0;
  }

  const messages: ChatMessage[] = [];
  const counts = new Map<string, number>();
  for (const r of raws) {
    const sm = r.rest.match(SENDER_RE);
    if (!sm) continue; // system notice ("X added Y", encryption banner)
    const sender = sm[1].replace(/^[‎‏]+/, "").trim();
    const body = sm[2].replace(/^[‎‏]+/, "").trim();
    if (!body || DROP_BODY_RE.test(body)) continue;
    let hour = r.h;
    if (r.ampm === "p" && hour < 12) hour += 12;
    if (r.ampm === "a" && hour === 12) hour = 0;
    const year = r.y < 100 ? 2000 + r.y : r.y;
    const day = dayFirst ? r.d1 : r.d2;
    const month = dayFirst ? r.d2 : r.d1;
    const at = new Date(year, month - 1, day, hour, r.mi, r.s);
    if (Number.isNaN(at.getTime()) || at.getMonth() !== month - 1) {
      skippedLines += 1;
      continue;
    }
    messages.push({ senderKey: sender, at: at.toISOString(), text: body });
    counts.set(sender, (counts.get(sender) ?? 0) + 1);
  }

  const participants: ChatParticipant[] = [...counts.keys()].map((key) => ({
    key,
    displayName: key,
    phoneE164: normalizePhoneLoose(key),
    email: null,
    isSelf: SELF_LABELS.has(key.toLowerCase()),
  }));
  const others = participants.filter((p) => !p.isSelf);
  return {
    source: "whatsapp",
    fileName,
    title: titleFromFileName(fileName) ?? (others.length === 1 ? others[0].displayName : fileName.replace(/\.(txt|zip)$/i, "")),
    isGroup: participants.length > 2,
    participants,
    messages,
    dateOrderGuessed,
    skippedLines,
  };
}
```
Note: a 1:1 export where the owner's label is their own name (not "You") has 2 participants and no `isSelf`. That is expected; the preview asks "which sender is you".

- [ ] **Step 5: Run** — `npx tsx scripts/smoke-chat-parsers.ts && npm run typecheck` → passes. If the phone-twin checks fail, change `phone.ts` to match `duplicates.ts`, never the reverse.
- [ ] **Step 6: Commit** — `feat(chat-imports): conversation types and WhatsApp export parser`

---

### Task 2: The iMessage parser

**Files:**
- Create: `src/lib/conversations/imessage.ts`
- Modify: `scripts/smoke-chat-parsers.ts`

**Interfaces:**
- Consumes: Task 1 types, `normalizePhoneLoose`.
- Produces: `parseIMessageExport(text: string, fileName: string): Conversation`; exported `IMESSAGE_HEADER_RE`.

The supported input is the open-source `imessage-exporter` `--format txt` output (github.com/ReagentX/imessage-exporter). **Before writing the parser, open that project's README/docs (WebFetch) and confirm the txt layout.** The layout below is the one assumed here: blocks separated by a blank line; first line a timestamp (optionally followed by a parenthetical such as a read receipt); second line the sender (`Me` for the owner, otherwise a handle or a contact name); then body lines. If the docs differ, adjust `IMESSAGE_HEADER_RE`, the block logic and the fixtures to the documented layout, and say so in the report.

- [ ] **Step 1: Add failing checks to the smoke**

```ts
import { parseIMessageExport } from "../src/lib/conversations/imessage";

const im = [
  "Mar 05, 2024  2:03:45 PM",
  "+14155550134",
  "Are we still on for Thursday?",
  "",
  "Mar 05, 2024  2:05:01 PM (Read by +14155550134 after 2 minutes)",
  "Me",
  "Yes! 6pm at Tartine",
  "Can't wait",
  "",
  "Mar 06, 2024  9:00:00 AM",
  "+14155550134",
  "Loved “Yes! 6pm at Tartine”",
  "",
].join("\n");
const i1 = parseIMessageExport(im, "+14155550134.txt");
check("imessage: 2 real messages (tapback dropped)", i1.messages.length === 2, JSON.stringify(i1.messages));
check("imessage: multi-line body", i1.messages[1].text === "Yes! 6pm at Tartine\nCan't wait");
check("imessage: Me is self", i1.participants.find((p) => p.key === "Me")?.isSelf === true);
check("imessage: handle phone", i1.participants.find((p) => !p.isSelf)?.phoneE164 === "+14155550134");
check("imessage: title from file", i1.title === "+14155550134" && i1.isGroup === false);
check("imessage: PM", new Date(i1.messages[0].at).getHours() === 14);

const email = parseIMessageExport("Jan 02, 2025  10:00:00 AM\nana@example.com\nhi there\n", "ana@example.com.txt");
check("imessage: email handle", email.participants.find((p) => !p.isSelf)?.email === "ana@example.com");

const grp = parseIMessageExport(
  "Jan 02, 2025  10:00:00 AM\n+14155550134\nhey all\n\nJan 02, 2025  10:01:00 AM\n+14155550199\nhi\n",
  "+14155550134, +14155550199.txt"
);
check("imessage: group from file name", grp.isGroup === true);
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `imessage.ts`**

```ts
/**
 * imessage-exporter `--format txt`: blank-line separated blocks of
 *   <timestamp>[ (receipt…)]
 *   <sender>            "Me" for the owner, else a handle or contact name
 *   <body line(s)>
 * Tapback lines ("Loved “…”", "Liked “…”", …) are reactions, not messages, and are dropped.
 * The file name is the chat's handle list ("+1415…, +1415….txt") or its display name.
 */
import { normalizePhoneLoose } from "@/lib/conversations/phone";
import type { ChatMessage, ChatParticipant, Conversation } from "@/lib/conversations/types";

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
export const IMESSAGE_HEADER_RE = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s?([AP]M)\b/;
const TAPBACK_RE = /^(?:Loved|Liked|Disliked|Laughed at|Emphasized|Questioned|Removed a [a-z]+ from) [“"]/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseIMessageExport(text: string, fileName: string): Conversation {
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n\s*\n/);
  const messages: ChatMessage[] = [];
  const counts = new Map<string, number>();
  let skippedLines = 0;
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.length > 0);
    if (lines.length < 3) {
      if (block.trim()) skippedLines += 1;
      continue;
    }
    const h = lines[0].match(IMESSAGE_HEADER_RE);
    if (!h || MONTHS[h[1]] == null) {
      skippedLines += 1;
      continue;
    }
    let hour = Number(h[4]);
    if (h[7] === "PM" && hour < 12) hour += 12;
    if (h[7] === "AM" && hour === 12) hour = 0;
    const at = new Date(Number(h[3]), MONTHS[h[1]], Number(h[2]), hour, Number(h[5]), Number(h[6]));
    const sender = lines[1].trim();
    const body = lines.slice(2).join("\n").trim();
    if (!sender || !body || TAPBACK_RE.test(body)) continue;
    messages.push({ senderKey: sender, at: at.toISOString(), text: body });
    counts.set(sender, (counts.get(sender) ?? 0) + 1);
  }
  messages.sort((x, y) => x.at.localeCompare(y.at));

  const participants: ChatParticipant[] = [...counts.keys()].map((key) => ({
    key,
    displayName: key,
    phoneE164: normalizePhoneLoose(key),
    email: EMAIL_RE.test(key) ? key.toLowerCase() : null,
    isSelf: key === "Me",
  }));
  const title = fileName.replace(/^.*[\\/]/, "").replace(/\.txt$/i, "");
  const handlesInName = title.split(",").map((s) => s.trim()).filter(Boolean);
  const others = participants.filter((p) => !p.isSelf);
  return {
    source: "imessage",
    fileName,
    title,
    isGroup: handlesInName.length > 1 || others.length > 1,
    participants,
    messages,
    dateOrderGuessed: false,
    skippedLines,
  };
}
```

- [ ] **Step 4: Run** — `npx tsx scripts/smoke-chat-parsers.ts && npm run typecheck` → passes.
- [ ] **Step 5: Commit** — `feat(chat-imports): iMessage (imessage-exporter txt) parser`

---

### Task 3: Sessions, transcripts, conversation keys

**Files:**
- Create: `src/lib/conversations/sessions.ts`
- Create: `scripts/smoke-chat-sessions.ts`; register `"smoke-chat-sessions": "pure"`

**Interfaces:**
- Consumes: Task 1 types, `fnv1a64`.
- Produces:
  - `conversationKey(c: Conversation): string` — `fnv1a64(source | title | sorted participant keys)`, stable across re-exports of the same chat.
  - `splitSessions(c: Conversation, selfKey: string | null): ChatSession[]`
  - `sessionExternalId(source: ChatSource, key: string, startAtIso: string, contactId: string): string`
  - `groupHeader(c: Conversation): string` — `# Group chat "<title>" with <non-self names>`

- [ ] **Step 1: Write the failing smoke**

```ts
/**
 * Session splitting: gap > 6h, 200 messages or 12k chars; transcript line format; the last
 * message decides direction; keys are stable across re-exports.
 * Run: npx tsx scripts/smoke-chat-sessions.ts
 */
import "./smoke/_env";
import { conversationKey, groupHeader, sessionExternalId, splitSessions } from "../src/lib/conversations/sessions";
import type { Conversation } from "../src/lib/conversations/types";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const t0 = new Date(2024, 2, 13, 9, 0, 0).getTime();
const at = (mins: number) => new Date(t0 + mins * 60_000).toISOString();
function conv(msgs: Array<[number, string, string]>, extra: Partial<Conversation> = {}): Conversation {
  return {
    source: "whatsapp", fileName: "x.txt", title: "Maya", isGroup: false,
    participants: [
      { key: "Maya", displayName: "Maya", phoneE164: null, email: null, isSelf: false },
      { key: "You", displayName: "You", phoneE164: null, email: null, isSelf: true },
    ],
    messages: msgs.map(([m, s, t]) => ({ senderKey: s, at: at(m), text: t })),
    dateOrderGuessed: false, skippedLines: 0, ...extra,
  };
}

const c = conv([[0, "Maya", "hi"], [5, "You", "hey"], [5 + 6 * 60, "Maya", "exactly 6h later"], [5 + 12 * 60 + 1, "Maya", "6h01 later"]]);
const s = splitSessions(c, "You");
check("gap: 6h exactly stays together, > 6h splits", s.length === 2, JSON.stringify(s.map((x) => x.messageCount)));
check("session 1 direction from last message", s[0].direction === "in");
check("transcript line format", s[0].transcript.split("\n")[0] === "[2024-03-13 09:00 Maya] hi", s[0].transcript);
check("self label rendered as Me", s[0].transcript.includes(" Me] hey"));
check("start/end", s[0].startAt === at(0) && s[0].endAt === at(5 + 6 * 60));
check("unknown owner → null direction", splitSessions(c, null)[0].direction === null);

const many = conv(Array.from({ length: 450 }, (_, i) => [i, "Maya", `m${i}`] as [number, string, string]));
const sm = splitSessions(many, "You");
check("200-message cap", sm.length === 3 && sm[0].messageCount === 200 && sm[2].messageCount === 50);

const long = conv(Array.from({ length: 30 }, (_, i) => [i, "Maya", "y".repeat(1_000)] as [number, string, string]));
check("12k-char cap", splitSessions(long, "You").every((x) => x.transcript.length <= 12_000));

check("key stable across content", conversationKey(c) === conversationKey(conv([[0, "Maya", "different text"]])));
check("key differs by title", conversationKey(c) !== conversationKey({ ...c, title: "Other" }));
check(
  "external id format",
  sessionExternalId("whatsapp", "abc", at(0), "11111111-1111-4111-8111-111111111111") ===
    `chat:whatsapp:abc:${Math.floor(t0 / 1000)}:11111111-1111-4111-8111-111111111111`
);
const g = conv([[0, "Ana", "hi"]], {
  isGroup: true, title: "Founders",
  participants: [
    { key: "Ana", displayName: "Ana", phoneE164: null, email: null, isSelf: false },
    { key: "Ben", displayName: "Ben", phoneE164: null, email: null, isSelf: false },
    { key: "You", displayName: "You", phoneE164: null, email: null, isSelf: true },
  ],
});
check("group header", groupHeader(g) === '# Group chat "Founders" with Ana, Ben');

console.log("\nsmoke-chat-sessions: all checks passed");
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `sessions.ts`**

```ts
/**
 * A chat becomes "sessions": runs of messages with no gap over 6 hours, split further at 200
 * messages or 12,000 characters. One session is one timeline entry, so a 10,000-message chat
 * is a few hundred rows, not 10,000. Transcript times are rendered in the local zone the
 * parser read them in.
 */
import { fnv1a64 } from "@/lib/conversations/hash";
import {
  SESSION_GAP_MS, SESSION_MAX_CHARS, SESSION_MAX_MESSAGES,
  type ChatSession, type ChatSource, type Conversation,
} from "@/lib/conversations/types";

export function conversationKey(c: Conversation): string {
  const keys = c.participants.map((p) => p.key).sort().join("\u001f");
  return fnv1a64(`${c.source}\u001f${c.title}\u001f${keys}`);
}

export function sessionExternalId(source: ChatSource, key: string, startAtIso: string, contactId: string): string {
  return `chat:${source}:${key}:${Math.floor(new Date(startAtIso).getTime() / 1000)}:${contactId}`;
}

export function groupHeader(c: Conversation): string {
  const names = c.participants.filter((p) => !p.isSelf).map((p) => p.displayName);
  return `# Group chat "${c.title}" with ${names.join(", ")}`;
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function line(atIso: string, speaker: string, text: string): string {
  const d = new Date(atIso);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `[${stamp} ${speaker}] ${text.replace(/\s*\n\s*/g, " / ")}`;
}

export function splitSessions(c: Conversation, selfKey: string | null): ChatSession[] {
  const sessions: ChatSession[] = [];
  type Cur = { lines: string[]; chars: number; start: string; end: string; count: number; lastSender: string };
  let cur: Cur | null = null;
  const flush = () => {
    if (!cur) return;
    sessions.push({
      startAt: cur.start,
      endAt: cur.end,
      messageCount: cur.count,
      direction: selfKey == null ? null : cur.lastSender === selfKey ? "out" : "in",
      transcript: cur.lines.join("\n"),
    });
    cur = null;
  };
  let prevAt = -Infinity;
  for (const m of c.messages) {
    const t = new Date(m.at).getTime();
    const speaker = selfKey != null && m.senderKey === selfKey ? "Me" : m.senderKey;
    let l = line(m.at, speaker, m.text);
    if (l.length > SESSION_MAX_CHARS) l = l.slice(0, SESSION_MAX_CHARS);
    const gap = t - prevAt > SESSION_GAP_MS;
    if (!cur || gap || cur.count >= SESSION_MAX_MESSAGES || cur.chars + l.length + 1 > SESSION_MAX_CHARS) {
      flush();
      cur = { lines: [], chars: 0, start: m.at, end: m.at, count: 0, lastSender: m.senderKey };
    }
    cur.lines.push(l);
    cur.chars += l.length + 1;
    cur.end = m.at;
    cur.count += 1;
    cur.lastSender = m.senderKey;
    prevAt = t;
  }
  flush();
  return sessions;
}
```

- [ ] **Step 4: Run** — passes; typecheck clean.
- [ ] **Step 5: Commit** — `feat(chat-imports): session splitting, transcripts, stable keys`

---

### Task 4: Schema v148 — chat row payload and saved self names

**Files:**
- Modify: `src/db/schema.ts` (payload type + `ImportJobRowPayload` union, near `LinkedInMessageThreadRowPayload`; `userSettings`)
- Modify: `src/db/index.ts` (user_settings CREATE TABLE in the `DDL` template; `alters`; `migratePglite` `ensureColumn`; `SCHEMA_VERSION = 148` + changelog)
- Modify: `scripts/schema-ddl.lock.json` (via `--update`)
- Modify: `scripts/smoke-relationship-schema.ts`

**Interfaces:**
- Produces:
```ts
export type ChatConversationRowPayload = {
  kind: "chat_conversation";
  source: "whatsapp" | "imessage";
  conversationKey: string;
  isGroup: boolean;
  title: string;
  participant: { key: string; displayName: string; phoneE164: string | null; email: string | null };
  /** Picked or auto-linked in the preview. Must name one of the user's contacts; re-verified by the engine. */
  resolvedContactId?: string | null;
  /** 1:1 → true. Group member → true only if the user ticked "add as contact". */
  createIfUnmatched: boolean;
  sessions: { startAt: string; endAt: string; messageCount: number; direction: "in" | "out" | null; transcript: string }[];
};
```
  - `userSettings.chatSelfNames` — `jsonb("chat_self_names").$type<string[]>().default([]).notNull()` (house convention: string arrays are jsonb).

- [ ] **Step 1:** Add to `scripts/smoke-relationship-schema.ts`: `check("user_settings.chat_self_names", (await columns("user_settings")).has("chat_self_names"));`. Run → FAIL.
- [ ] **Step 2:** Add the type next to `LinkedInMessageThreadRowPayload` and append it to the `ImportJobRowPayload` union. Add the column next to `relationshipEngineEnabled`.
- [ ] **Step 3:** DDL — in the template's `user_settings` CREATE TABLE add `  chat_self_names jsonb NOT NULL DEFAULT '[]',`; append to `alters`:
```ts
  // Schema v148: sender labels the owner picked as "me" in chat exports (WhatsApp has no "Me").
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS chat_self_names jsonb NOT NULL DEFAULT '[]'`,
```
  in `migratePglite` add `await ensureColumn(client, "user_settings", "chat_self_names", "jsonb NOT NULL DEFAULT '[]'");` next to the `relationship_engine_enabled` one; set `SCHEMA_VERSION = 148` with a changelog comment `148 = user_settings.chat_self_names (relationship engine P2). 147 is P1 (PR #398).`. Grep `relationship_engine_enabled` in `src/lib/user-data.ts` (preserved settings columns for purge) and treat `chat_self_names` the same way.
- [ ] **Step 4:** `npx tsx scripts/smoke-schema-ddl.ts --update && npm run db:check && rm -rf .data/pglite-smoke*; npx tsx scripts/smoke-relationship-schema.ts && npm run typecheck` → pass.
- [ ] **Step 5: Commit** — `feat(chat-imports): chat row payload + chat_self_names (v148)`

---

### Task 5: Engine hook + chat adapter + registration

**Files:**
- Modify: `src/lib/import-engine.ts` (`ImportAdapter` type ~101-158; contact load ~403-415; Jev name-fold loop ~548-565; per-row loop ~571-610)
- Create: `src/lib/import-adapters/chat.ts`
- Modify: `src/lib/import-adapters/index.ts`, `src/lib/import-job-dispatch.ts`, `src/lib/imports/import-sources.ts`, `src/components/imports/import-history.tsx` (`SOURCE_ICON`), `src/app/(clerk)/(admin)/admin/analytics/engagement/page.tsx` (`IMPORT_LABELS`)
- Create: `scripts/smoke-chat-import-engine.ts` (pglite)

**Interfaces:**
- Consumes: `ChatConversationRowPayload` (Task 4), `sessionExternalId` (Task 3), `kickRelationshipRun` (P1 runner).
- Produces: `ImportAdapter.resolvedContactId?(payload: P): string | null`; `WHATSAPP_CHAT_IMPORT_TYPE = "whatsapp_chat"`, `IMESSAGE_CHAT_IMPORT_TYPE = "imessage_chat"`, `chatAdapter(source)`.

- [ ] **Step 1: Write the failing smoke.** `scripts/smoke-chat-import-engine.ts` mirrors the LinkedIn-messages section of `scripts/smoke-import-engine.ts` (~825-990): read its `seedJob` helper and copy its shape (stage an `imports` row + `import_job_rows`, call `runImportJob(importId)`). User `smoke-chat-import-user`; reset deletes interactions, import rows, imports, contacts and identities for that user. Build payloads with a local helper `row(over: Partial<ChatConversationRowPayload>)`. Cases:
  1. **Pinned contact wins.** Seed two contacts both named "Maya Chen". Stage a 1:1 row with `resolvedContactId` = the second → its sessions land on the second contact only; contact count unchanged.
  2. **Stale pin falls back.** `resolvedContactId` = a random uuid not owned by the user, `createIfUnmatched: true`, participant "Zed Quinn" → a new contact "Zed Quinn" tagged `whatsapp`; the random id is never written.
  3. **Unticked group member is skipped.** `createIfUnmatched: false`, no pin → row status `skipped`, no contact, no interactions.
  4. **Phone identity on create.** Participant `phoneE164: "+14155550134"` → `contact_identities` has `phone_e164 = +14155550134` for the new contact.
  5. **Session rows.** Two sessions → two `interactions` rows: `interaction_type 'message'`, `source 'whatsapp'`, `interaction_date` = each `endAt`, `external_id` = `sessionExternalId(...)` with the contact id, `ai_summary` = first 240 chars, `raw_notes` = the transcript verbatim.
  6. **Re-import grows a session in place.** Re-stage the same conversation where the last session has one more line (same `startAt`, later `endAt`) in a new import → still two rows; the second row's `interaction_date` and `raw_notes` are updated.
  7. **iMessage** registered under `imessage_chat` produces `source 'imessage'`.
  8. **finalize** completes without throwing in the smoke env (the kick is best-effort).
  Register `"smoke-chat-import-engine": "pglite"`. Run → FAIL.

- [ ] **Step 2: The engine hook.** In `ImportAdapter<P>` add:
```ts
  /**
   * A contact the person already picked for this row (an import preview's picker). When it
   * names one of this user's contacts the row merges into it and identity matching is not
   * consulted. A stale id (deleted or merged since the preview) falls back to identity().
   */
  resolvedContactId?(payload: P): string | null;
```
After `duplicateIndex = buildDuplicateIndex(existingContacts);` build `const contactById = new Map(existingContacts.map((c) => [c.id, c]));` (declare it beside the other `let`s if the try-block scoping needs it). Add a local helper:
```ts
        const pinnedSubject = (payload: ImportJobRowPayload) => {
          const id = adapter.resolvedContactId?.(payload) ?? null;
          return id ? contactById.get(id) : undefined;
        };
```
In the Jev `nameFolds` loop, `if (pinnedSubject(row.payload as ImportJobRowPayload)) continue;` before computing the probe. At the top of the per-row loop, right after `const payload = row.payload as ImportJobRowPayload;`:
```ts
          const pinned = pinnedSubject(payload);
          if (pinned) {
            toUpdate.push({ row, contactId: pinned.id, input: adapter.toMerge(payload, pinned) });
            continue;
          }
```
Contacts created later in the same job are not added to `contactById`: a pin always names a pre-existing contact.

- [ ] **Step 3: The adapter** — `src/lib/import-adapters/chat.ts`:
```ts
/**
 * WhatsApp and iMessage conversations, one row per (conversation, participant). Rows are
 * built in the browser after a preview that already decided who each participant is, so
 * `resolvedContactId` usually settles the match; a row with neither a pin nor permission to
 * create (an unticked group member) is skipped, never auto-created.
 */
import type { ChatConversationRowPayload } from "@/db/schema";
import type { ImportAdapter, InteractionInsert } from "@/lib/import-engine";
import { sessionExternalId } from "@/lib/conversations/sessions";
import { kickRelationshipRun } from "@/lib/relationship-engine/runner";

export const WHATSAPP_CHAT_IMPORT_TYPE = "whatsapp_chat";
export const IMESSAGE_CHAT_IMPORT_TYPE = "imessage_chat";

const LABEL = { whatsapp: "WhatsApp", imessage: "iMessage" } as const;

function range(p: ChatConversationRowPayload) {
  const starts = p.sessions.map((s) => s.startAt).sort();
  const ends = p.sessions.map((s) => s.endAt).sort();
  return {
    earliest: starts.length ? new Date(starts[0]) : null,
    latest: ends.length ? new Date(ends[ends.length - 1]) : null,
  };
}

export function chatAdapter(source: "whatsapp" | "imessage"): ImportAdapter<ChatConversationRowPayload> {
  return {
    resolvedContactId(p) {
      return p.resolvedContactId ?? null;
    },
    identity(p) {
      if (!p.createIfUnmatched) return null;
      return { fullName: p.participant.displayName, email: p.participant.email ?? undefined };
    },
    toCreate(p) {
      const { earliest, latest } = range(p);
      return {
        fullName: p.participant.displayName,
        phone: p.participant.phoneE164 ?? undefined,
        email: p.participant.email ?? undefined,
        source: `${source}_chat`,
        relationshipScore: 2,
        howMet: `${LABEL[source]} messages`,
        metContext: "online",
        tagNames: [source],
        firstInteractionAt: earliest ?? undefined,
        dateMet: latest ? latest.toISOString() : undefined,
      };
    },
    toMerge(p) {
      const { earliest, latest } = range(p);
      return {
        phone: p.participant.phoneE164 ?? undefined,
        email: p.participant.email ?? undefined,
        firstInteractionAt: earliest ?? undefined,
        lastInteractionAt: latest ?? undefined,
      };
    },
    interactions(p, contactId, userId): InteractionInsert[] {
      return p.sessions
        .filter((s) => s.transcript.trim())
        .map((s) => ({
          userId,
          contactId,
          interactionType: "message",
          interactionDate: new Date(s.endAt),
          source,
          externalId: sessionExternalId(source, p.conversationKey, s.startAt, contactId),
          rawNotes: s.transcript,
          aiSummary: s.transcript.slice(0, 240),
          topics: [],
          direction: s.direction,
        }));
    },
    async finalize(userId, contactIds) {
      if (contactIds.length === 0) return;
      await kickRelationshipRun(userId);
    },
  };
}
```
Before keeping `toMerge`'s `phone`/`email`, read `bulkMergeContactsForUser` (`src/lib/contact-writes.ts`). If those columns OVERWRITE a non-empty value on merge (rather than filling only when empty), drop them from `toMerge` and say so in the report. Also check the `ownWrites` behaviour in `src/lib/imports/import-undo.ts` (it reads `toCreate`'s `tagNames`/`notes`) still classifies these rows correctly — tags `["whatsapp"]`/`["imessage"]` are the import's own writes.

- [ ] **Step 4: Register.**
  1. `src/lib/import-adapters/index.ts`: add `[WHATSAPP_CHAT_IMPORT_TYPE]: chatAdapter("whatsapp")` and `[IMESSAGE_CHAT_IMPORT_TYPE]: chatAdapter("imessage")` to `ADAPTERS`.
  2. `src/lib/import-job-dispatch.ts`: import and re-export both constants; add both to `RESUMABLE_IMPORT_TYPES`; add `case` lines in `runImportJobById` returning `runImportJob(importId)`.
  3. `src/lib/imports/import-sources.ts` `IMPORT_SOURCE_LABEL`: `whatsapp_chat: "WhatsApp chats"`, `imessage_chat: "iMessage chats"`.
  4. `src/components/imports/import-history.tsx` `SOURCE_ICON`: both, matching the `{ icon, badge }` shape (lucide `MessageCircle` for WhatsApp, `MessageSquareText` for iMessage, or the nearest icons already imported there).
  5. Admin `IMPORT_LABELS`: both.

- [ ] **Step 5: Run** — `npx tsx scripts/smoke-chat-import-engine.ts && npx tsx scripts/smoke-import-engine.ts && npx tsx scripts/smoke-import-sources.ts && npx tsx scripts/smoke-import-undo.ts && npm run typecheck` → all pass (`smoke-import-engine` proves adapters without the hook are unchanged).
- [ ] **Step 6: Commit** — `feat(chat-imports): engine pin hook, WhatsApp/iMessage adapter, registration`

---

### Task 6: The `feature` surface kind and `feature.chat-imports`

**Files:**
- Modify: `src/lib/surfaces.ts` (`SurfaceKind`; a `FEATURES` array spread into `SURFACES`; `COMING_SOON_KEYS` derived from `PAGES` **and** `FEATURES`; the `comingSoon` doc comment → "Pages and features")
- Modify: `src/app/(clerk)/(admin)/admin/product/page.tsx` (a "Features" section via `surfacesOfKind("feature")`, mirroring the existing sections)
- Modify: `scripts/smoke-surface-visibility.ts`

**Interfaces:**
- Produces: `export const CHAT_IMPORTS_SURFACE_KEY = "feature.chat-imports";` and the surface `{ key: CHAT_IMPORTS_SURFACE_KEY, kind: "feature", label: "Chat imports (WhatsApp, iMessage)", description: "Upload WhatsApp and iMessage exports for relationship analysis. Hidden until the privacy policy discloses chat content.", comingSoon: true }`.

- [ ] **Step 1:** Add smoke checks, following how the smoke already tests a coming-soon page (`page.outreach`): `isSurfaceLive(USER, CHAT_IMPORTS_SURFACE_KEY)` is `false` for a normal user and for an admin without the preview cookie, and live when previewing unreleased. Run → FAIL.
- [ ] **Step 2:** Implement. Keep `surfaces.ts` pure (client components import it). If any `Record<SurfaceKind, …>` exists, tsc will flag it — add the `feature` entry.
- [ ] **Step 3:** Add the admin section.
- [ ] **Step 4:** `npx tsx scripts/smoke-surface-visibility.ts && npm run typecheck` → pass (also `smoke-admin-render` if it exists: `ls scripts | grep admin-render`).
- [ ] **Step 5: Commit** — `feat(surfaces): feature kind + feature.chat-imports (coming soon)`, body: "direct-email #379 adds the same kind; whichever merges second keeps one FEATURES array".

---

### Task 7: Preview matching + chunked staging

**Files:**
- Create: `src/lib/conversations/to-rows.ts` (pure)
- Create: `src/lib/chat-import-preview.ts` (server-only)
- Create: `src/actions/chat-imports.ts` (`"use server"`)
- Modify: `src/app/api/imports/process-stalled/route.ts` (sweep abandoned `staging` imports)
- Create: `scripts/smoke-chat-import-actions.ts` (pglite) — tests the lib functions directly, not the auth-wrapped actions

**Interfaces:**
- Consumes: Tasks 1–6; `findIdentityOwners` (`src/lib/contact-identity.ts`), `buildDuplicateIndex` / `findDuplicateCandidatesIndexed` / `DUPLICATE_MERGE_CONFIDENCE` (`src/lib/duplicates.ts`), `isSelf` (`src/lib/meeting-digest.ts`), `loadMeetingSelf` (`src/lib/meeting-sessions.ts`), `estimateCostMicros` (`src/lib/ai-pricing.ts`), `getAiConfig` (`src/lib/ai.ts`), `stageImportRows` (`src/lib/import-job-rows.ts`), `runImportJobById`, `isSurfaceLive`, `refusal` (the helper `src/actions/imports.ts` uses — import it from wherever it is defined).
- Produces:
```ts
// src/lib/conversations/to-rows.ts (pure)
export type ParticipantDecision = { contactId: string | null; create: boolean };
export function conversationToRows(
  c: Conversation, selfKey: string | null, decisions: Record<string, ParticipantDecision>
): ChatConversationRowPayload[];

// src/lib/chat-import-preview.ts
export type ChatPreviewParticipant = { key: string; displayName: string; phoneE164: string | null; email: string | null };
export type ChatPreviewConversation = {
  key: string; source: "whatsapp" | "imessage"; title: string; isGroup: boolean;
  participants: ChatPreviewParticipant[]; messageCount: number; chars: number; firstAt: string; lastAt: string;
};
export type ChatCandidate = { contactId: string; fullName: string; confidence: number; reason: string };
export type ChatPreviewResult = {
  conversations: Array<{
    key: string;
    /** The label the owner most likely is, or null → ask. iMessage: "Me". */
    suggestedSelfKey: string | null;
    participants: Array<{ key: string; autoContactId: string | null; candidates: ChatCandidate[] }>;
  }>;
  estimate: { micros: number; model: string } | null;
};
type Gate = { surfaceLive?: boolean }; // test seam; actions never pass it
export async function buildChatPreview(userId: string, convs: ChatPreviewConversation[], gate?: Gate): Promise<ChatPreviewResult>;
export async function beginStaging(userId: string, input: { source: "whatsapp" | "imessage"; fileName: string; selfNames: string[] }, gate?: Gate): Promise<{ importId: string }>;
export async function appendStagedRows(userId: string, importId: string, startIndex: number, rows: unknown[], gate?: Gate): Promise<{ appended: number }>;
export async function startStaged(userId: string, importId: string, gate?: Gate): Promise<{ totalRows: number }>;
export async function sweepAbandonedStaging(now?: Date): Promise<number>;

// src/actions/chat-imports.ts — requireUserId + lib call; failures returned as refusal data
export async function previewChatConversations(convs: ChatPreviewConversation[]): Promise<ChatPreviewResult | { error: string }>;
export async function beginChatImport(input: { source: "whatsapp" | "imessage"; fileName: string; selfNames: string[] }): Promise<{ importId: string } | { error: string }>;
export async function appendChatRows(importId: string, startIndex: number, rows: unknown[]): Promise<{ appended: number } | { error: string }>;
export async function startChatImport(importId: string): Promise<{ totalRows: number } | { error: string }>;
```

Rules (write them as comments in the code; each one is tested):
- **Gate.** Every lib entry point except the sweep throws unless `gate?.surfaceLive ?? (await isSurfaceLive(userId, CHAT_IMPORTS_SURFACE_KEY))`.
- **Self.** A participant is the owner if its label is in `user_settings.chat_self_names` (case-insensitive), or `isSelf(label, await loadMeetingSelf(userId))`, or the label is `Me` (iMessage) or `You` (WhatsApp). Owners get no candidates. `suggestedSelfKey` = the first owner label found, else null.
- **Auto-link.** Link when exactly one identifier owner exists (`findIdentityOwners` on the participant's `phone_e164` / `email`), or when the best name-index match (`buildDuplicateIndex` over the user's contacts, built once per call) has confidence `>= DUPLICATE_MERGE_CONFIDENCE`. Otherwise `autoContactId: null` and up to 3 candidates (best first) with confidence `>= 0.6`. Read `findIdentityOwners`' real signature before use.
- **Estimate.**
  - Input tokens: `ceil(chars / 4)` per conversation, split evenly across its non-owner participants.
  - Output tokens: 600 per non-owner participant.
  - The first 25 participants are priced at full rate, the rest with `batch: true`, using `(await getAiConfig(userId, "relationship.digest")).model`.
  - Any throw from `getAiConfig` (no key) → `estimate: null`.
  - `estimateCostMicros` returning null (unpriced model) → `estimate: null`.
- **beginStaging.**
  - Inserts `imports` `{ userId, importType: source === "whatsapp" ? WHATSAPP_CHAT_IMPORT_TYPE : IMESSAGE_CHAT_IMPORT_TYPE, fileName, status: "staging", totalRows: 0, stats: {} }`. Check the real column names on `imports` first.
  - Saves `selfNames` into `chat_self_names`: merged with the existing names, deduped case-insensitively, keeping the 5 most recently given.
- **appendStagedRows.**
  - Requires the import to be the caller's, in `staging`, with the matching import type; `rows.length <= MAX_APPEND_ROWS`.
  - Every row passes a zod schema mirroring `ChatConversationRowPayload`: `kind === "chat_conversation"`, `source` matches the import, strings bounded (title/displayName ≤ 200, key ≤ 300), `sessions.length <= 5000`, every transcript ≤ 12,000 chars, ISO dates parse.
  - Stages `{ importId, userId, rowIndex: startIndex + i, payload }` via `stageImportRows`, then increments `imports.totalRows` by the count.
- **startStaged.** Requires `staging`. Sets `status: "processing"` and `totalRows` = count of the import's `import_job_rows`, and returns it. The action wrapper then calls `after(() => runImportJobById(importId).catch(() => {}))` and `revalidatePath("/imports")`, mirroring `startLinkedInMessagesImport`.
- **sweepAbandonedStaging.** Deletes `imports` with `status = 'staging'` and `created_at` older than 24 h (job rows cascade; verify the FK). Called from process-stalled in a try block matching that file's style, with a stat counter.
- **Readers of `imports.status`.** Grep them first (`grep -rn "imports.status\|\.status === \"processing\"\|status: \"processing\"" src`). Make the import history list exclude `staging` rows, and make sure no other reader treats `staging` as failed or done. Record what you changed.
- **conversationToRows.**
  - Calls `splitSessions(c, selfKey)` once and `conversationKey(c)` once.
  - Group conversations prefix every session transcript with `groupHeader(c) + "\n"`, cutting the transcript's tail so the total stays ≤ 12,000.
  - Emits one row per non-owner participant where the decision has a `contactId` or `create: true`.
  - Default decision when absent: 1:1 → `{ contactId: null, create: true }`; group member → `{ contactId: null, create: false }`.
  - A row's `resolvedContactId` is the decision's `contactId`, and `createIfUnmatched` is the decision's `create`.

- [ ] **Step 1: Failing smoke.** `scripts/smoke-chat-import-actions.ts` (user `smoke-chat-actions-user`; reset clears contacts, identities, imports, import_job_rows, user_settings for that user; every lib call passes `{ surfaceLive: true }` except one gate check). Cases:
  - **gate:** `buildChatPreview(USER, [], { surfaceLive: false })` throws.
  - **auto-link by phone:** a contact created via `createContactsBulkForUser` (or the helper other smokes use) with phone `+14155550134` → that participant's `autoContactId` is it.
  - **ambiguous name:** two contacts "Maya Chen" → `autoContactId: null`, 2 candidates.
  - **self:** `chat_self_names = ["Jay P"]` → "Jay P" is `suggestedSelfKey` with no candidates; an iMessage conversation suggests `Me`.
  - **estimate:** `null` (smoke env has no AI key).
  - **staging:**
    - begin → `status 'staging'`, and a query with the stall cron's selector (`status = 'processing'`) does not return it;
    - two appends → contiguous `row_index` 0..n-1;
    - an append with a 13,000-char transcript is refused;
    - an append to another user's import is refused;
    - start → `processing`, `totalRows` matches;
    - an append after start is refused.
  - **self names:** persist, deduped, capped at 5.
  - **sweep:** a `staging` import created 25 h ago is deleted; a fresh one stays.
  - **conversationToRows:**
    - 1:1 default → 1 row with `createIfUnmatched: true`;
    - group default → 0 rows;
    - group with one member ticked → 1 row whose every transcript starts with `# Group chat`;
    - the owner never gets a row.
  Register `"smoke-chat-import-actions": "pglite"`. Run → FAIL.
- [ ] **Step 2: Implement** `to-rows.ts`, `chat-import-preview.ts`, the actions, the sweep call.
- [ ] **Step 3: Run** — `npx tsx scripts/smoke-chat-import-actions.ts && npx tsx scripts/smoke-import-stall.ts && npm run typecheck && npx eslint src/actions/chat-imports.ts src/lib/chat-import-preview.ts src/lib/conversations` → pass.
- [ ] **Step 4: Commit** — `feat(chat-imports): preview matching and chunked staging`

---

### Task 8: The chat import job in the client runner

**Files:**
- Modify: `src/lib/import-job-runner.ts` (`ImportJobKind`, `ImportJobInput`, `ServerOwnedKind`, `importJobLabel`, `importStarter`, `importedLabelFor`)
- Modify: `src/components/settings/integrations-dialog.tsx` (`tabForImportJob` → `null` for `"chat"`, like `contacts_file`)
- Modify: `scripts/smoke-settings-layout.ts` only if its rule demands a case body per kind

**Interfaces:**
- Consumes: Task 7 actions; `MAX_APPEND_ROWS` (types.ts).
- Produces: an `ImportJobInput` member `{ kind: "chat"; source: "whatsapp" | "imessage"; fileName: string; selfNames: string[]; rows: ChatConversationRowPayload[] }`, and this starter case (adapt to the real return/throw conventions of `importStarter` — read its `messages` case first):
```ts
    case "chat": {
      const begun = await beginChatImport({ source: job.source, fileName: job.fileName, selfNames: job.selfNames });
      if ("error" in begun) throw new UserFacingError(begun.error);
      // ~1.5 MB of JSON per call keeps every action well under the 4.5 MB function body limit.
      let batch: ChatConversationRowPayload[] = [];
      let bytes = 0;
      let index = 0;
      const flush = async () => {
        if (!batch.length) return;
        const res = await appendChatRows(begun.importId, index, batch);
        if ("error" in res) throw new UserFacingError(res.error);
        index += batch.length;
        batch = [];
        bytes = 0;
      };
      for (const row of job.rows) {
        const size = JSON.stringify(row).length;
        if (batch.length && (bytes + size > 1_500_000 || batch.length >= MAX_APPEND_ROWS)) await flush();
        batch.push(row);
        bytes += size;
      }
      await flush();
      const started = await startChatImport(begun.importId);
      if ("error" in started) throw new UserFacingError(started.error);
      return { importId: begun.importId, totalRows: started.totalRows };
    }
```
  Label "conversations"; total = `rows.length`; polling as for the other server-owned kinds.

- [ ] **Step 1:** `grep -l import-job-runner scripts/smoke-*.ts` — if a smoke exercises the runner's kinds, add a `chat` case there; otherwise typecheck gates this wiring and Task 10's browser pass exercises it.
- [ ] **Step 2:** Implement; `npm run typecheck && npx tsx scripts/smoke-settings-layout.ts` → pass.
- [ ] **Step 3: Commit** — `feat(chat-imports): chunked chat import job in the client runner`

---

### Task 9: Engine read side — newest rows, session speaker, group attribution

**Files:**
- Modify: `src/lib/relationship-engine/gather.ts`, `src/lib/relationship-engine/extract.ts`
- Modify: `scripts/smoke-relationship-pending.ts` (pglite DB cases), `scripts/smoke-relationship-gather.ts`, `scripts/smoke-relationship-extract.ts`

**Interfaces:** `loadMessageWindows(userId, contactIds, opts?)` gains `opts.rowLimit?: number` (default `ROW_LIMIT`); nothing else changes.

- [ ] **Step 1: Newest rows.**
  - **Today:** `loadMessageWindows` reads the OLDEST `ROW_LIMIT` (2,000) rows past the watermark, so for a long backlog `buildWindow`'s keep-the-newest truncation never sees the newest messages.
  - **Change:** read the newest `rowLimit` rows past the watermark (`ORDER BY m.interaction_date DESC, m.id DESC LIMIT rowLimit`), then reverse to oldest-first.
  - **Truncation:** if exactly `rowLimit` rows came back, older unread rows exist. Set the window's `truncatedBefore` to the first kept row's date, the earlier of that and what `buildWindow` sets itself. You may need to pass a flag into `buildWindow` or set it after.
  - **Keep as they are:** P1's payload upper bound, the shared `MESSAGE_INTERACTION_SQL` and `WATERMARK_AFTER_SQL`.
  - **Pglite case:** `rowLimit: 5` with 8 tiny rows past the watermark → the window contains the newest row, its first message is row 4 (0-based) and `truncatedBefore` is set.
- [ ] **Step 2: Session speaker.**
  - **Change:** for an `interaction_type 'message'` row (a chat session), the window message's speaker is `"Chat"` whatever its direction; the transcript carries its own per-line speakers. Thread `interactionType` through the row mapping, and make `speakerFor` take it, or special-case it in the mapper.
  - **Smoke:** a `message` row renders as `[YYYY-MM-DD Chat] [....`.
- [ ] **Step 3: Group attribution rule.** Append to `SYSTEM` in `extract.ts`:
```
- Some messages are chat transcripts with their own "[time Name] text" lines, where "Me" is the user. If a transcript starts with "# Group chat", other people are present: extract only what the contact named above said, or what was promised to or by them, and ignore everyone else's facts and commitments.
```
  Smoke: the system prompt contains `# Group chat`.
- [ ] **Step 4: Run** — `npx tsx scripts/smoke-relationship-pending.ts && npx tsx scripts/smoke-relationship-gather.ts && npx tsx scripts/smoke-relationship-extract.ts && npx tsx scripts/smoke-relationship-runner.ts && npx tsx scripts/smoke-ai-batch.ts && npm run typecheck` → pass.
- [ ] **Step 5: Commit** — `feat(relationships): read newest rows, chat session speaker, group attribution rule`

---

### Task 10: The Chat messages card (UI)

**Files:**
- Create: `src/lib/conversations/read-files.ts` (browser)
- Create: `src/components/imports/chat-messages-import.tsx`, `src/components/imports/chat-conversation-review.tsx`
- Modify: `src/components/imports/import-hub.tsx`; the server page that renders `ImportHub` (`grep -rn "<ImportHub" src/app`) passes `chatImports: boolean` from `isSurfaceLive(userId, CHAT_IMPORTS_SURFACE_KEY)`
- Create: `scripts/smoke-chat-read-files.ts` (pure); register `"smoke-chat-read-files": "pure"`

**Interfaces:**
```ts
// read-files.ts
export type ChatFile = { fileName: string; text: string; source: ChatSource };
export function detectChatSource(fileName: string, head: string): ChatSource | null;
export async function readChatFiles(files: File[]): Promise<{ files: ChatFile[]; ignored: string[] }>;
```
- **`detectChatSource`:**
  - `whatsapp` when one of the first 5 non-empty lines matches `WHATSAPP_LINE_RE` and contains `": "` after the timestamp;
  - `imessage` when the first non-empty line matches `IMESSAGE_HEADER_RE`;
  - otherwise `null`.
- **`readChatFiles`:**
  - `.txt` → `file.text()`.
  - `.zip` → `const { default: JSZip } = await import("jszip")`. Read only members ending `.txt`, preferring `_chat.txt`, and never call `async` on any other member. Use the zip's own name as `fileName`, since it carries the WhatsApp chat title.
  - Files over `MAX_CONTACTS_FILE_BYTES` (`src/lib/imports/import-constants.ts`) and files `detectChatSource` rejects go to `ignored`.

The card, top to bottom. Read `linkedin-messages-import.tsx` first and mirror its structure, state handling, primitives and copy voice; reuse `ImportFilePicker` and `useImportJob`.
1. **Pick files.** Multi-select `.txt`/`.zip`. Copy: "Export a chat from WhatsApp (Export chat → Without media) or with imessage-exporter, then add the files here. Media is never uploaded".
2. **Parse in the browser.**
   - `parseWhatsAppExport` / `parseIMessageExport` per file. `localeDayFirst` is true when `new Intl.DateTimeFormat().formatToParts(new Date(2024, 0, 31))` puts the `day` part before the `month` part.
   - Show per file: message count, date span, and "Dates guessed — check them" when `dateOrderGuessed`.
3. **Preview.** Send `ChatPreviewConversation[]` (counts, names, handles — no message text) to `previewChatConversations`.
4. **Which sender is you (WhatsApp).**
   - Shown when any WhatsApp conversation has `suggestedSelfKey === null`.
   - One picker for the upload, listing the sender labels seen in those files, with the most frequent cross-file label preselected.
   - The choice applies to every conversation containing that label.
5. **Review** (`chat-conversation-review.tsx`), one row per conversation:
   - Title, a 1:1/group badge, message count, date span, and an include checkbox (default on).
   - **1:1:** when auto-linked, "Linked to <name>" with a "Change" control. Otherwise a select of candidates plus "New contact", defaulting to "New contact" when there are no candidates.
   - **Group:** per non-owner member: "Linked to <name>" when auto-linked; else a candidate select when candidates exist; else an unticked "Add as contact" checkbox. Caption: "Only people you link or add are analyzed".
6. **Estimate line.**
   - With an estimate: "Analyzing ~N messages ≈ $X on your AI key".
   - With `estimate: null`: "Add an AI key in Settings to analyze these — the conversations are saved either way".
7. **Start.**
   - Build rows with `conversationToRows(c, selfKey, decisions)` for every included conversation.
   - Group the rows by source and run `startImportJob({ kind: "chat", … })` for WhatsApp, then for iMessage once it finishes (the runner allows one job at a time).
   - Show the existing progress UI.

Mount it in `import-hub.tsx` as a new `ImportSourceRow` after LinkedIn messages:
- id `import-panel-chats`, title "Chat messages", lucide `MessageCircle` icon, the messages accent;
- loaded with `dynamic()` like its siblings;
- rendered **only when `chatImports` is true**;
- anchor added to `ROW_FOR_ANCHOR`.

- [ ] **Step 1: Failing pure smoke** for `read-files.ts`:
  - `detectChatSource` on WhatsApp iOS and Android heads, an iMessage head, a CSV head (→ null) and plain prose (→ null).
  - A zip built with JSZip in the smoke (as `smoke-import-detect.ts` does) containing `_chat.txt` and `IMG-0001.jpg` → one `ChatFile` with the `.txt` text.
  - The jpg member's `async` is never called: wrap it before passing the zip blob, by building the zip, loading it, and spying via `JSZip.prototype`. If spying proves brittle, assert via a member-list check and note that.
  Smoke fixtures must be `File`s; Node 20+ has a global `File`. Run → FAIL.
- [ ] **Step 2: Implement** `read-files.ts` (smoke passes), then the components and the hub mount.
- [ ] **Step 3: Verify in the browser.**
  - **Setup:**
    - `npm ci` if `node_modules` is missing.
    - Create `.claude/launch.json` if missing (port 3001, or the next free one; never kill a server on 3000 belonging to another checkout), then `preview_start`.
    - Local dev is the demo workspace.
    - Make the coming-soon surface visible with the "Preview unreleased" cookie: read `surface-visibility.ts` for its exact name and how `/admin/product` sets it.
  - **Fixtures:** write three inline fixtures to the scratchpad, never the repo: a 1:1 WhatsApp `.txt` with ambiguous dates, a WhatsApp group `.txt`, and an iMessage `.txt`.
  - **Walk through and check:**
    - parse summary and the "dates guessed" note;
    - the self picker;
    - the review: auto-link (seed a matching demo contact if needed), the candidate select, and the group's "Add as contact" box;
    - Start → job reaches done → the linked contacts' timelines show the session interactions → `/imports` history shows "WhatsApp chats" / "iMessage chats".
  - **Negative check:** without the cookie, the card is absent.
  - **Wrap-up:** `read_console_messages` must show no errors; screenshot the review step. Stop the dev server before running smokes again (PGlite single-writer).
- [ ] **Step 4:** `npm run typecheck && npx eslint src/components/imports/chat-*.tsx src/lib/conversations src/components/imports/import-hub.tsx` → clean.
- [ ] **Step 5: Commit** — `feat(chat-imports): chat messages card with browser parsing and review`

---

### Task 11: Route dropped chat files to the card

**Files:**
- Modify: `src/components/imports/import-dropzone.tsx` (add `.txt,text/plain` to `accept` only when `chatImports` is on; take the flag as a prop)
- Modify: `src/lib/imports/detect-import-file.ts` (`detectImportFiles(files, { maxBytes, chatImports })`; the result gains `chatFiles: File[]`: a `.txt`, or a `.zip` whose readable members are only `.txt` files, is set aside as a chat file rather than reported as "a ZIP with nothing Orbit reads inside")
- Create: `src/lib/imports/chat-handoff.ts` — a module bus read with `useSyncExternalStore` (`handOffChatFiles(files: File[])`, `useChatHandoff(): File[]`, `clearChatHandoff()`)
- Modify: `src/components/imports/import-hub.tsx` (`handleFiles`: if `chatFiles.length`, `handOffChatFiles(chatFiles)` and scroll to `#import-panel-chats`), `chat-messages-import.tsx` (consume the handoff exactly as if the user picked those files, then clear it)
- Modify: `scripts/smoke-import-detect.ts`

- [ ] **Step 1: Failing checks** in `smoke-import-detect.ts`:
  - `chatImports: true`:
    - a WhatsApp `.txt` and a zip containing only `_chat.txt` land in `chatFiles`;
    - neither becomes a target or an error.
  - `chatImports: false`:
    - the same `.txt` behaves exactly as today;
    - the zip still reports what it reports today.
  - `messages.csv` and `Connections.csv` still classify as before.
  Run → FAIL.
- [ ] **Step 2: Implement.** `detectImportFiles` stays pure (no React). The one-file-per-target rule for CSV targets is untouched.
- [ ] **Step 3:** `npx tsx scripts/smoke-import-detect.ts && npx tsx scripts/smoke-import-queue.ts && npx tsx scripts/smoke-toast-copy.ts && npm run typecheck` → pass. Browser: with the preview cookie, drop a WhatsApp `.txt` anywhere on `/imports` → the chat card shows it parsed.
- [ ] **Step 4: Commit** — `feat(chat-imports): dropped chat exports route to the chat card`

---

### Task 12: Chat eval fixtures

**Files:**
- Modify: `scripts/eval-fixtures/ai-relationship-eval.json`
- Modify: `scripts/lib/eval-ai-fixtures.ts`, `scripts/lib/eval-ai-tasks.ts` (optional `forbiddenFacts`)

- [ ] **Step 1:** Extend `RelationshipEvalFixture` cases with optional `forbiddenFacts?: string[]`. In `runRelationshipTask`, count every validated fact (and `whatTheyDo`/`workingOn`) that `mentions` a forbidden phrase into `inventedItems`.
- [ ] **Step 2:** Add 4 cases. Each chat case is ONE message whose `text` is a session transcript in the Task 3 line format, `from: "them"`:
  1. `whatsapp-1to1-dated`: `now` 2026-09-30.
     - Transcript dated 2026-09-27 (a Sunday): `[2026-09-27 10:00 Maya] Can you send the term sheet by Friday?` / `[2026-09-27 10:05 Me] Yes, Friday works`.
     - Expect: commitment `{ phrase: "term sheet", owedBy: "me", dueIso: "2026-10-02" }`, 1 reminder, 0 threads.
  2. `whatsapp-group-attribution`: contact "Ana Ruiz", `now` 2026-09-30.
     - Transcript dated 2026-09-28, starts `# Group chat "Founders" with Ana Ruiz, Ben Ode`.
     - Ana says she'll introduce the user to her investor next week. Ben says he is moving to Berlin.
     - Expect: facts `[]`, 1 commitment `them` with phrase "intro" and `dueIso: "2026-10-05"` ("next week" = the Monday after the anchor; confirm against `relative-date.ts`), `forbiddenFacts: ["Berlin"]`, 1 reminder (the day-after check-in for a `them` item).
  3. `imessage-old-plan`: `now` 2026-09-30.
     - Transcript dated 2025-01-10: `[2025-01-10 18:00 +14155550134] Dinner next Thursday?` / `[2025-01-10 18:02 Me] Sounds great`.
     - Expect: 0 reminders, 1 open thread.
  4. `whatsapp-pleasantries`: `Happy birthday!!` / `Thank you!!` as two short messages → `trivial: true`.
- [ ] **Step 3:** Run the keyless direct invocation used in P1 Task 12 (call `runRelationshipTask` from a throwaway script, not committed). The trivial case must pass, and the rest must fail only on the missing key. Then `npx tsx scripts/smoke-eval-ai-score.ts && npm run typecheck`.
- [ ] **Step 4: Commit** — `test(relationships): chat transcript eval fixtures`

---

### Task 13: Full verification

- [ ] **Step 1:** Stop any dev server on this worktree. `npm run test:check && npm run test 2>&1 | tail -15` → all pass. Rerun load flakes alone (admin-render, instrumentation, radar-run, admin-credits, sync-scheduler).
- [ ] **Step 2:** `npm run typecheck && npm run lint 2>&1 | tail -5 && npm run build 2>&1 | tail -20` → clean, 0 lint errors, build succeeds. A `node:fs` chunk error means something under `src/lib/conversations/` (or a client component) reached server code.
- [ ] **Step 3:** `npx tsx scripts/smoke-behavior-golden.ts`; if it fails only on `chat_self_names` defaults, `--update` and confirm the diff contains nothing else.
- [ ] **Step 4:** Schema-number re-scan (Global Constraints); renumber above the highest found and update the lock if needed.
- [ ] **Step 5: Commit** any golden or lock update.

---

## Self-review notes

- **Spec coverage, §2 (parsers, identity, sessions):**
  - Parsers: Tasks 1–2.
  - Sessions: Task 3.
  - Identity, self, auto-link and picker: Task 7 (preview) and Task 5 (pin hook, phone identity on create).
  - Groups-known-only: Tasks 5 and 7.
- **Spec coverage, §6 upload:** Tasks 10–11. Deviation: a dedicated card, not the shared queue (Decision 1).
- **Spec coverage, §7:** Task 6. The privacy/TERMS change itself remains an owner decision.
- **Spec coverage, §8 smokes:** `smoke-chat-parsers`, `smoke-chat-sessions`, `smoke-chat-import-engine`, `smoke-chat-import-actions`, `smoke-chat-read-files`, plus updates.
- **Spec coverage, eval:** Task 12 adds the chat cases P1 deferred.
- **P1 deferred items closed here:** `ROW_LIMIT` read the oldest rows (Task 9).
- **P1 deferred items still open (P3):**
  - cron backstop starvation and keyless churn;
  - idle-run finalize;
  - `run.import_id`;
  - merge dropping the loser's digest;
  - the owner's name in the prompt;
  - LinkedIn-keyed readers ignoring chat rows (Decision 6).
- **Type consistency:** `ChatConversationRowPayload` (Task 4) is the one shape used by `conversationToRows` (Task 7), the adapter (Task 5), the append zod schema (Task 7) and the runner (Task 8). `MAX_APPEND_ROWS` lives in `types.ts` so the client runner can import it. `WHATSAPP_LINE_RE` and `IMESSAGE_HEADER_RE` are exported in Tasks 1–2 and consumed in Task 10.
- **Known judgment calls:**
  - Session times are local to the parsing browser.
  - A relative date said late in a session that crosses midnight anchors to the session's message line date (correct per line in the transcript, since each line carries its date).
  - `fnv1a64` collisions across a user's chats are negligible at this scale.
