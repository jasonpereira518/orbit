# Google Drive Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Choose from Google Drive" button on `/imports` that lets a person pick Google Docs and Slides, suggests which look like notes, and runs the kept ones through capture's extraction — people, a logged meeting, and reminders under stricter rules — as a resumable `drive_docs` import.

**Architecture:** `drive.file` scope + the Google Picker (browser) chooses files; a server action stages one `import_job_rows` row per file; a dedicated resumable processor (`runDriveImportJob`, the Gmail-scan pattern) exports each doc as text, calls `runCaptureParse`, filters reminders through pure strictness rules, and writes through capture's own `saveNoteBatch`. Pure modules (triage, reminder rules, Drive client) carry the logic worth testing; the processor takes injected deps so a PGlite smoke runs it with no network and no model.

**Tech Stack:** Next.js 16 App Router (read `node_modules/next/dist/docs/` before touching routing/actions — this is NOT the Next.js you know), Drizzle over Neon/PGlite, Google Drive API v3 REST, Google Picker (`apis.google.com/js/api.js`), tsx smoke scripts via `scripts/run-smoke.ts`.

**Spec:** `docs/superpowers/specs/2026-09-21-google-drive-import-design.md`

## Global Constraints

- Branch: `claude/google-drive-import` (cut from `claude/imports-page-redesign-decdb0`, PR #238). Do not push to #238.
- **No DDL. `SCHEMA_VERSION` stays 73.** `import_type` is text, `stats` and `payload` are jsonb.
- Scope: `https://www.googleapis.com/auth/drive.file` only. Never `drive.readonly` / `drive.metadata.readonly` (restricted).
- File types: `application/vnd.google-apps.document` and `application/vnd.google-apps.presentation` only.
- Cap: **25 files per import**.
- `capture` `confidenceScore` is on a **0–100** scale (see `EXPLICIT_AUTO_TICK_CONFIDENCE = 60`). The spec's "0.85" means **85**.
- Env: `NEXT_PUBLIC_GOOGLE_PICKER_API_KEY`, `NEXT_PUBLIC_GOOGLE_APP_ID` — **optional**; never add them to the required list in `src/lib/env.ts` (it gates every prod deploy). Unset → the Drive button is not rendered.
- Connecting Google already requires the paid `sync` entitlement (`startGmailOAuth` → `requireSyncUser`). Drive inherits that gate; free plans see the button locked.
- **`"use server"` files may export only async functions.** No `export const`, no `export type { … }` re-export specifiers (both silently kill every export in the module, and neither `tsc` nor `next build` catches it — only loading the route in `next dev` does). Plain `export type X = …` declarations are fine. Shared constants/types go in `src/lib/`.
- House voice (enforced repo-wide by `scripts/smoke-toast-copy.ts`): curly apostrophe `’`, "Couldn’t" never "Could not", never the word "failed" in user copy, no trailing period, at most one ` — ` connector per line. Never render `err.message`; use `friendlyError(err, fallback)` / `UserFacingError`.
- Every new smoke script must be registered in `MANIFEST` in `scripts/run-smoke.ts` (tier `"pure"` or `"pglite"`); an unregistered script fails the whole suite. Every tsx script ends with `process.exit(0)`.
- **PGlite is single-writer:** stop any `next dev` for this worktree before running a pglite smoke or `npm test`.
- Gates before every commit: `npx tsc --noEmit` clean; `npx eslint .` shows **0 errors** (baseline 44 warnings).
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Deviations from the spec (settled while planning — the spec will be updated in Task 9)

1. **Re-import dedupe uses capture's own key, not a new `drive:` external id.** `saveNoteBatch` already writes interactions as `notes:<sourceHash>:<contactId>`, so identical text never double-logs. The processor additionally skips a doc whose text hash matches an already-saved note batch ("Already brought in — unchanged since"). An *edited* doc is a new corpus and saves a new batch.
2. **Date anchor goes in as `hints.eventDate`** (the doc's `modifiedTime` day), which `runCaptureParse` already supports; the resulting `anchorBasis` is `"hint"`, not `"upload"`.
3. **Follow-up reminders get the future-only rule too.** `saveNoteBatch` writes one follow-up per person due `anchor + followUpDays`; for an old doc that is already overdue, so `createReminder` is turned off when that date has passed.
4. **Extra people per doc ride the row payload** (`payload.contactIds`), not extra rows. `import-people.ts` unions `contact_id` with `payload->'contactIds'`, so the detail sheet's people list covers every person and "Rows" still counts docs.
5. **Drive picks get their own card** (`DriveImportCard`) in the queue card's slot rather than entering the file queue — the queue's vocabulary is file detection (`ImportTarget`), and a Drive pick is not a file.

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/lib/google-scopes.ts` | modify | `drive` purpose + `drive.file` scope |
| `src/actions/gmail.ts` | modify | `canImportDrive` on `GmailConnectionStatus` |
| `src/lib/imports/drive-reminder-rules.ts` | create | Pure: which suggested reminders to keep, which to flag; follow-up future check |
| `src/lib/imports/drive-triage.ts` | create | Pure: does a picked file look like notes, and why |
| `src/lib/drive.ts` | create | Drive REST: export a file as text, typed errors |
| `src/lib/capture-job-runner.ts` | modify | Extract `saveInputFromParse` from `buildSaveInput` |
| `src/lib/drive-import-type.ts` | create | `DRIVE_IMPORT_TYPE` constant, import-free (cycle safety) |
| `src/db/schema.ts` | modify | `DriveFileRowPayload`, `ImportStats` drive fields (types only) |
| `src/lib/drive-import-processor.ts` | create | Staging + resumable runner with injected deps |
| `src/lib/import-job-dispatch.ts` | modify | Register the type and its runner |
| `src/lib/imports/import-people.ts` | modify | Union `payload->'contactIds'` |
| `src/actions/drive.ts` | create | `getDrivePickerToken`, `startDriveImport`, `dismissDriveFlag` |
| `src/lib/import-job-runner.ts` | modify | `drive_docs` job kind |
| `src/lib/imports/import-sources.ts`, `import-summary.ts`, `src/components/imports/import-history.tsx` | modify | Label, icon, chips, **Worth a look** section |
| `src/lib/imports/google-picker.ts` | create | Client: load gapi + open the Picker |
| `src/components/imports/drive-import-card.tsx` | create | Picked files, triage reasons, Import button |
| `src/components/imports/import-dropzone.tsx`, `import-hub.tsx`, `src/app/(clerk)/(app)/(main)/imports/page.tsx` | modify | Third button + wiring |
| `src/lib/security-headers.ts` | modify | CSP for the Picker |
| Smokes | create/modify | `smoke-google-scopes` (mod), `smoke-drive-reminder-rules`, `smoke-drive-triage`, `smoke-drive-client`, `smoke-drive-import`, `smoke-import-people` (mod), `smoke-security-headers` (mod), `smoke-import-history-render` (mod) |

---

### Task 1: `drive` purpose and scope

**Files:**
- Modify: `src/lib/google-scopes.ts`
- Modify: `src/actions/gmail.ts` (`GmailConnectionStatus`, `getGmailConnectionStatus`)
- Test: `scripts/smoke-google-scopes.ts`

**Interfaces:**
- Produces: `GOOGLE_SCOPES.drive`, `GooglePurpose` now includes `"drive"`, `requiredScopeFor("drive") === GOOGLE_SCOPES.drive`, `grantCovers("drive", scopes)`, `GmailConnectionStatus.canImportDrive: boolean`.

- [ ] **Step 1: Write the failing test.** Append to `scripts/smoke-google-scopes.ts` before its final summary/exit block:

```ts
// Drive: files the person picks, nothing else — never a restricted Drive scope.
check("drive is a purpose", isGooglePurpose("drive"));
check(
  "drive asks for drive.file only",
  requiredScopeFor("drive") === "https://www.googleapis.com/auth/drive.file",
);
check(
  "drive consent = identity + drive.file",
  JSON.stringify(googleScopesFor("drive")) ===
    JSON.stringify([...identity, GOOGLE_SCOPES.drive]),
);
check(
  "no restricted Drive scope anywhere",
  !Object.values(GOOGLE_SCOPES).some((s) => /drive\.(readonly|metadata)/.test(s)),
);
check(
  "a contacts-only grant doesn't cover drive",
  !grantCovers("drive", `openid ${GOOGLE_SCOPES.contacts}`),
);
check(
  "missing drive scope has its own line",
  missingScopeMessage("drive") === "Google didn’t grant Drive access — reconnect and allow it",
);
```

- [ ] **Step 2: Run it — expect FAIL.** `npx tsx scripts/smoke-google-scopes.ts` → tsc-in-tsx may pass but `check("drive is a purpose")` prints `FAIL`.

- [ ] **Step 3: Implement.** In `src/lib/google-scopes.ts`:

```ts
export const GOOGLE_SCOPES = {
  openid: "openid",
  email: "https://www.googleapis.com/auth/userinfo.email",
  contacts: "https://www.googleapis.com/auth/contacts.readonly",
  gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
  gmailSend: "https://www.googleapis.com/auth/gmail.send",
  calendar: "https://www.googleapis.com/auth/calendar.readonly",
  // Only files the person picks in the Google Picker. Non-sensitive; the restricted
  // drive.readonly would need a CASA assessment, which is why whole-Drive search is later.
  drive: "https://www.googleapis.com/auth/drive.file",
} as const;

export const GOOGLE_PURPOSES = ["contacts", "recruiter_scan", "send", "calendar", "event_mail", "drive"] as const;
```

Add `drive: GOOGLE_SCOPES.drive,` to `PURPOSE_SCOPE`, and a case to `missingScopeMessage`:

```ts
    case "drive":
      return "Google didn’t grant Drive access — reconnect and allow it";
```

In `src/actions/gmail.ts`, add to `GmailConnectionStatus` after `hasCalendarScope`:

```ts
  /** The grant covers drive.file, so the Drive picker can open. */
  canImportDrive: boolean;
```

Set `canImportDrive: false` in the not-configured return, and in every other return of `getGmailConnectionStatus` set `canImportDrive: grantCovers("drive", conn?.scopes)` (or `false` where there is no `conn`) — mirror exactly how `canImportContacts` is computed in the same function. Import `grantCovers` from `@/lib/google-scopes` if not already imported.

- [ ] **Step 4: Run tests.** `npx tsx scripts/smoke-google-scopes.ts` → all `ok`. `npx tsc --noEmit` → clean (it will flag any other exhaustive `Record<GooglePurpose, …>` — add a `drive` entry to each with the same shape as `calendar`). Check the privacy page still renders its scope table from `GOOGLE_SCOPES`: `grep -rn "GOOGLE_SCOPES\|googleScopesFor" src/app` and confirm any per-scope description map gains a `drive` line: "See and open only the Google Docs and Slides you pick".

- [ ] **Step 5: Commit.**

```bash
git add src/lib/google-scopes.ts src/actions/gmail.ts scripts/smoke-google-scopes.ts src/app
git commit -m "Add a drive.file Google purpose for picking Docs and Slides

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Reminder strictness rules (pure)

**Files:**
- Create: `src/lib/imports/drive-reminder-rules.ts`
- Create: `scripts/smoke-drive-reminder-rules.ts` (register `"smoke-drive-reminder-rules": "pure"`)

**Interfaces:**
- Consumes: `SuggestedReminderPreview` from `@/lib/capture/types`.
- Produces:
  - `DRIVE_REMINDERS_PER_DOC = 3`, `FLAG_MIN_CONFIDENCE = 85`, `FLAG_LOOKBACK_DAYS = 30`
  - `type DriveFlag = { key: string; title: string; personName: string | null; dueDateIso: string; sourceExcerpt: string; actionKind: ReminderActionKind }`
  - `applyDriveReminderRules(suggestions: readonly SuggestedReminderPreview[], now: Date): { keep: string[]; flags: DriveFlag[] }`
  - `followUpStillAhead(anchorIso: string, days: number, now: Date): boolean`

- [ ] **Step 1: Write the failing test** `scripts/smoke-drive-reminder-rules.ts`:

```ts
/**
 * The stricter reminder rules for Drive imports. A doc can be years old, so capture's own
 * defaults would turn every stale "send the deck by March 3" into an overdue reminder.
 *
 * Run: npx tsx scripts/smoke-drive-reminder-rules.ts
 */
import {
  applyDriveReminderRules,
  followUpStillAhead,
} from "../src/lib/imports/drive-reminder-rules";
import type { SuggestedReminderPreview } from "../src/lib/capture/types";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const NOW = new Date("2026-09-21T12:00:00Z");

function s(key: string, over: Partial<SuggestedReminderPreview>): SuggestedReminderPreview {
  return {
    key,
    title: `Do ${key}`,
    description: null,
    rawDatePhrase: "on October 3",
    dueDateIso: "2026-10-03",
    yearInferred: false,
    personName: "Priya Raman",
    actionKind: "task",
    confidenceScore: 90,
    sourceExcerpt: "send the deck on October 3",
    dateBasis: "absolute",
    anchorIso: "2026-09-01",
    origin: "explicit",
    rationale: null,
    ...over,
  };
}

const r = applyDriveReminderRules(
  [
    s("future", {}),
    s("past-unimportant", { dueDateIso: "2026-09-10", confidenceScore: 70 }),
    s("past-important", { dueDateIso: "2026-09-10", confidenceScore: 92 }),
    s("past-too-old", { dueDateIso: "2026-06-01", confidenceScore: 95 }),
    s("past-relative", { dueDateIso: "2026-09-10", confidenceScore: 95, dateBasis: "relative" }),
    s("implied", { origin: "implied", rawDatePhrase: null }),
    s("vague", { dateBasis: "vague" }),
    s("no-phrase", { rawDatePhrase: null }),
    s("year-guessed", { yearInferred: true }),
  ],
  NOW,
);
check("a future explicit date is kept", r.keep.includes("future"));
check("a past, ordinary one is dropped", !r.keep.includes("past-unimportant") && !r.flags.some((f) => f.key === "past-unimportant"));
check("a past, important one is flagged, not kept", !r.keep.includes("past-important") && r.flags.some((f) => f.key === "past-important"));
check("a past one outside 30 days is not flagged", !r.flags.some((f) => f.key === "past-too-old"));
check("a past relative date is not flagged", !r.flags.some((f) => f.key === "past-relative"));
for (const k of ["implied", "vague", "no-phrase", "year-guessed"]) {
  check(`${k} is dropped`, !r.keep.includes(k) && !r.flags.some((f) => f.key === k));
}
check("only one kept overall", r.keep.length === 1, JSON.stringify(r.keep));

// Cap: at most three, highest confidence first.
const capped = applyDriveReminderRules(
  [
    s("a", { confidenceScore: 70 }),
    s("b", { confidenceScore: 95 }),
    s("c", { confidenceScore: 80 }),
    s("d", { confidenceScore: 90 }),
  ],
  NOW,
);
check("capped at three", capped.keep.length === 3);
check("lowest confidence is the one dropped", !capped.keep.includes("a"), JSON.stringify(capped.keep));

// Today counts as not past.
check("due today is kept", applyDriveReminderRules([s("today", { dueDateIso: "2026-09-21" })], NOW).keep.includes("today"));

// Follow-ups.
check("follow-up still ahead", followUpStillAhead("2026-09-15", 14, NOW));
check("follow-up already passed", !followUpStillAhead("2025-01-10", 14, NOW));

if (failures) {
  console.error(`smoke-drive-reminder-rules: ${failures} failed`);
  process.exit(1);
}
console.log("smoke-drive-reminder-rules: all checks passed");
process.exit(0);
```

- [ ] **Step 2: Run — expect FAIL** (module not found). `npx tsx scripts/smoke-drive-reminder-rules.ts`

- [ ] **Step 3: Implement** `src/lib/imports/drive-reminder-rules.ts`:

```ts
import type { SuggestedReminderPreview } from "@/lib/capture/types";
import type { ReminderActionKind } from "@/db/schema";

/**
 * Which of capture's suggested reminders a Drive import may create.
 *
 * Stricter than capture on purpose. In /capture a person reviews every suggestion before it
 * is saved, and the notes are usually from today. A Drive doc is read unattended and can be
 * years old, so capture's defaults would bury someone in overdue reminders for things long
 * done. The rules:
 *
 *  1. Only a date the notes actually state (`origin: "explicit"`, a date phrase, not vague,
 *     year not guessed). Nothing implied, nothing "soon".
 *  2. Only one still ahead of today.
 *  3. At most three per doc, most confident first.
 *
 * A stated date that has already passed, but only just, and that the parse is very sure
 * of, is not dropped silently: it comes back as a flag for the import's detail sheet,
 * where the person can make it a reminder with one click. Nothing is written for a flag.
 */
export const DRIVE_REMINDERS_PER_DOC = 3;
/** On capture's 0–100 scale (see `EXPLICIT_AUTO_TICK_CONFIDENCE`). */
export const FLAG_MIN_CONFIDENCE = 85;
export const FLAG_LOOKBACK_DAYS = 30;

export type DriveFlag = {
  key: string;
  title: string;
  personName: string | null;
  dueDateIso: string;
  sourceExcerpt: string;
  actionKind: ReminderActionKind;
};

/** YYYY-MM-DD in UTC, which is how `dueDateIso` is written. */
function dayOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function statedOutright(s: SuggestedReminderPreview): boolean {
  return (
    (s.origin ?? "explicit") === "explicit" &&
    Boolean(s.rawDatePhrase?.trim()) &&
    s.dateBasis !== "vague" &&
    !s.yearInferred
  );
}

export function applyDriveReminderRules(
  suggestions: readonly SuggestedReminderPreview[],
  now: Date,
): { keep: string[]; flags: DriveFlag[] } {
  const today = dayOf(now);
  const lookback = dayOf(new Date(now.getTime() - FLAG_LOOKBACK_DAYS * 86_400_000));

  const stated = suggestions.filter(statedOutright);

  const keep = stated
    .filter((s) => s.dueDateIso >= today)
    .sort((a, b) => b.confidenceScore - a.confidenceScore)
    .slice(0, DRIVE_REMINDERS_PER_DOC)
    .map((s) => s.key);

  const flags: DriveFlag[] = stated
    .filter(
      (s) =>
        s.dueDateIso < today &&
        s.dueDateIso >= lookback &&
        s.dateBasis === "absolute" &&
        s.confidenceScore >= FLAG_MIN_CONFIDENCE,
    )
    .map((s) => ({
      key: s.key,
      title: s.title,
      personName: s.personName,
      dueDateIso: s.dueDateIso,
      sourceExcerpt: s.sourceExcerpt,
      actionKind: s.actionKind,
    }));

  return { keep, flags };
}

/**
 * Whether a person's generic follow-up (due `anchor + days`) would still be ahead of today.
 * For an old doc it usually is not, and an overdue follow-up is noise, not a nudge.
 */
export function followUpStillAhead(anchorIso: string, days: number, now: Date): boolean {
  const due = new Date(`${anchorIso}T12:00:00Z`).getTime() + days * 86_400_000;
  return dayOf(new Date(due)) >= dayOf(now);
}
```

- [ ] **Step 4: Run** the smoke → all `ok`. Register `"smoke-drive-reminder-rules": "pure"` in `MANIFEST` (next to the other `smoke-import-*` pure entries), then `npx tsx scripts/run-smoke.ts --check` → `structure ok`. `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/imports/drive-reminder-rules.ts scripts/smoke-drive-reminder-rules.ts scripts/run-smoke.ts
git commit -m "Add stricter reminder rules for Drive imports

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Triage — does a picked file look like notes (pure)

**Files:**
- Create: `src/lib/imports/drive-triage.ts`
- Create: `scripts/smoke-drive-triage.ts` (register `"pure"`)

**Interfaces:**
- Produces:
  - `DRIVE_MIME = { doc: "application/vnd.google-apps.document", slides: "application/vnd.google-apps.presentation" } as const`
  - `type PickedDriveFile = { id: string; name: string; mimeType: string; modifiedTime: string /* ISO */ }`
  - `triageDriveFile(file: PickedDriveFile, now: Date): { likely: boolean; why: string }`

- [ ] **Step 1: Write the failing test** `scripts/smoke-drive-triage.ts`:

```ts
/**
 * Name-and-metadata triage for picked Drive files. Free and instant by design — no model
 * sees anything until the person has chosen — so it only has to be right about the obvious.
 *
 * Run: npx tsx scripts/smoke-drive-triage.ts
 */
import { DRIVE_MIME, triageDriveFile } from "../src/lib/imports/drive-triage";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const NOW = new Date("2026-09-21T12:00:00Z");
const RECENT = "2026-08-01T10:00:00Z";
const OLD = "2023-02-01T10:00:00Z";
const doc = (name: string, modifiedTime = RECENT, mimeType: string = DRIVE_MIME.doc) =>
  triageDriveFile({ id: "x", name, mimeType, modifiedTime }, NOW);

const likely = [
  "1:1 Priya / Jason",
  "Weekly sync notes",
  "Coffee with Marco",
  "Interview debrief — Lena Okafor",
  "2026-08-14 call with Stripe",
  "Standup",
  "Jason <> Ana intro",
  "Retro Q3",
];
for (const name of likely) check(`likely: ${name}`, doc(name).likely, doc(name).why);

const unlikely = [
  "Resume 2026",
  "Meeting notes template",
  "Q4 budget",
  "Product roadmap",
  "Pitch deck",
  "PRD: onboarding",
  "Invoice #221",
];
for (const name of unlikely) check(`not likely: ${name}`, !doc(name).likely, doc(name).why);

check("untitled is not pre-picked", !doc("Untitled document").likely);
check("untitled says why", /nothing to go on/i.test(doc("Untitled document").why));
check("a negative word beats a positive one", !doc("1:1 notes template").likely);
check("an old notes doc is still likely", doc("Weekly sync notes", OLD).likely);
check("a plain name that's recent is not pre-picked", !doc("Thoughts", RECENT).likely);
check("slides named like a meeting are likely", doc("Team sync", RECENT, DRIVE_MIME.slides).likely);
for (const name of [...likely, ...unlikely, "Untitled document"]) {
  const why = doc(name).why;
  check(`why reads clean: ${name}`, why.length > 0 && !why.endsWith(".") && !/'/.test(why), why);
}

if (failures) {
  console.error(`smoke-drive-triage: ${failures} failed`);
  process.exit(1);
}
console.log("smoke-drive-triage: all checks passed");
process.exit(0);
```

- [ ] **Step 2: Run — expect FAIL** (module not found).

- [ ] **Step 3: Implement** `src/lib/imports/drive-triage.ts`:

```ts
/**
 * Does a picked Drive file look like notes about people?
 *
 * Name and metadata only — the Picker hands us nothing else without reading the file, and
 * reading it before the person has chosen would mean spending their AI key on files they
 * are about to deselect. So this is deliberately simple, and wrong in the direction of
 * asking: a doc it isn't sure about is shown unticked, never hidden.
 */
export const DRIVE_MIME = {
  doc: "application/vnd.google-apps.document",
  slides: "application/vnd.google-apps.presentation",
} as const;

export type PickedDriveFile = {
  id: string;
  name: string;
  mimeType: string;
  /** ISO timestamp — the Picker's `lastEditedUtc`, converted. */
  modifiedTime: string;
};

const NEGATIVE: [RegExp, string][] = [
  [/\btemplate\b/i, "Looks like a template"],
  [/\b(resume|résumé|cv)\b/i, "Looks like a résumé"],
  [/\b(invoice|receipt|budget)\b/i, "Looks like finance, not notes"],
  [/\b(roadmap|spec|prd)\b/i, "Looks like a plan, not notes"],
  [/\b(pitch|deck)\b/i, "Looks like a presentation, not notes"],
];

const POSITIVE: [RegExp, string][] = [
  [/\b1\s*[:\-]\s*1\b|\b1on1\b|\bone[\s-]on[\s-]one\b/i, "Named like a 1:1"],
  [/\b(debrief|interview)\b/i, "Named like an interview debrief"],
  [/\b(standup|stand-up|sync|retro|meeting|call)\b/i, "Named like meeting notes"],
  [/\b(coffee|catch[\s-]?up|intro)\b/i, "Named like a conversation"],
  [/\bnotes?\b/i, "Named like notes"],
  [/\S\s*(<>|\/)\s*\S/, "Named after two people"],
  [/\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/, "Has a date in the name"],
];

export function triageDriveFile(
  file: PickedDriveFile,
  _now: Date,
): { likely: boolean; why: string } {
  const name = file.name.trim();
  if (!name || /^untitled( document| presentation)?$/i.test(name)) {
    return { likely: false, why: "The name gives nothing to go on" };
  }
  for (const [re, why] of NEGATIVE) {
    if (re.test(name)) return { likely: false, why };
  }
  for (const [re, why] of POSITIVE) {
    if (re.test(name)) return { likely: true, why };
  }
  return { likely: false, why: "Nothing in the name says notes" };
}
```

(`_now` stays in the signature so recency can be added without touching callers; recency is intentionally not a pre-tick signal on its own — a recent "Thoughts" is not notes.)

- [ ] **Step 4: Run** the smoke → all `ok`; if a named case fails, adjust the regex table, not the test. Register in `MANIFEST`; `--check`; tsc.

- [ ] **Step 5: Commit** — `git add src/lib/imports/drive-triage.ts scripts/smoke-drive-triage.ts scripts/run-smoke.ts && git commit -m "Suggest which picked Drive files look like notes …"` (with the Co-Authored-By line).

---

### Task 4: Drive client — export a file as text

**Files:**
- Create: `src/lib/drive.ts`
- Create: `scripts/smoke-drive-client.ts` (register `"pure"`)

**Interfaces:**
- Produces:
  - `DRIVE_EXPORT_MAX_CHARS = 200_000`
  - `class DriveFileUnavailableError extends Error` (name `"DriveFileUnavailableError"`)
  - `class DriveFileTooLargeError extends Error` (name `"DriveFileTooLargeError"`)
  - `exportDriveFileText(accessToken: string, fileId: string, fetchImpl?: typeof fetch): Promise<string>`

- [ ] **Step 1: Write the failing test** `scripts/smoke-drive-client.ts`:

```ts
/**
 * The Drive export call, against a stub fetch — no network. What matters is that each way
 * Google says no becomes an error the processor can map to a sentence, never a raw body.
 *
 * Run: npx tsx scripts/smoke-drive-client.ts
 */
import {
  DRIVE_EXPORT_MAX_CHARS,
  DriveFileTooLargeError,
  DriveFileUnavailableError,
  exportDriveFileText,
} from "../src/lib/drive";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

let lastUrl = "";
let lastAuth = "";
function stub(status: number, body: string): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    lastUrl = String(url);
    lastAuth = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(body, { status });
  }) as typeof fetch;
}

async function rejects(p: Promise<unknown>, cls: new (...a: never[]) => Error) {
  try {
    await p;
    return false;
  } catch (e) {
    return e instanceof cls;
  }
}

async function main() {
  const text = await exportDriveFileText("tok", "abc/123", stub(200, "﻿Hello Priya"));
  check("returns the text, BOM stripped", text === "Hello Priya", JSON.stringify(text));
  check("asks for plain text", lastUrl.includes("/files/abc%2F123/export?mimeType=text%2Fplain"), lastUrl);
  check("sends the bearer token", lastAuth === "Bearer tok");

  check("404 → unavailable", await rejects(exportDriveFileText("t", "x", stub(404, "{}")), DriveFileUnavailableError));
  check("403 → unavailable", await rejects(exportDriveFileText("t", "x", stub(403, '{"error":{"errors":[{"reason":"forbidden"}]}}')), DriveFileUnavailableError));
  check(
    "403 exportSizeLimitExceeded → too large",
    await rejects(exportDriveFileText("t", "x", stub(403, '{"error":{"errors":[{"reason":"exportSizeLimitExceeded"}]}}')), DriveFileTooLargeError),
  );
  check("huge text → too large", await rejects(exportDriveFileText("t", "x", stub(200, "a".repeat(DRIVE_EXPORT_MAX_CHARS + 1))), DriveFileTooLargeError));

  let raw = "";
  try {
    await exportDriveFileText("t", "x", stub(500, "<html>internal secret body</html>"));
  } catch (e) {
    raw = e instanceof Error ? e.message : "";
  }
  check("a 500 never carries the body", raw.length > 0 && !raw.includes("secret"), raw);

  if (failures) {
    console.error(`smoke-drive-client: ${failures} failed`);
    process.exit(1);
  }
  console.log("smoke-drive-client: all checks passed");
  process.exit(0);
}
void main();
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** `src/lib/drive.ts`:

```ts
/**
 * Google Drive, read-only, for files the person picked (`drive.file`).
 *
 * One call: export a Doc or Slides deck as plain text. Both types support `text/plain`
 * export; Google caps any export at 10 MB and says so with `exportSizeLimitExceeded`.
 * Errors carry no response body — the processor maps them to its own sentences.
 */
const DRIVE_API = "https://www.googleapis.com/drive/v3";

/** Past this the doc is a book, not notes, and the parse would cost more than it's worth. */
export const DRIVE_EXPORT_MAX_CHARS = 200_000;

export class DriveFileUnavailableError extends Error {
  constructor() {
    super("Drive file unavailable");
    this.name = "DriveFileUnavailableError";
  }
}

export class DriveFileTooLargeError extends Error {
  constructor() {
    super("Drive file too large to read");
    this.name = "DriveFileTooLargeError";
  }
}

export async function exportDriveFileText(
  accessToken: string,
  fileId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent("text/plain")}`;
  const res = await fetchImpl(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 403) {
    const body = await res.text().catch(() => "");
    if (body.includes("exportSizeLimitExceeded")) throw new DriveFileTooLargeError();
    throw new DriveFileUnavailableError();
  }
  if (res.status === 404) throw new DriveFileUnavailableError();
  if (!res.ok) throw new Error(`Drive export returned ${res.status}`);

  const text = (await res.text()).replace(/^﻿/, "");
  if (text.length > DRIVE_EXPORT_MAX_CHARS) throw new DriveFileTooLargeError();
  return text;
}
```

- [ ] **Step 4: Run** → all `ok`; register; `--check`; tsc.

- [ ] **Step 5: Commit** — `git add src/lib/drive.ts scripts/smoke-drive-client.ts scripts/run-smoke.ts` and commit "Read a picked Drive file as plain text".

---

### Task 5: Extract `saveInputFromParse` from capture's `buildSaveInput`

Pure refactor so Drive can build the exact input capture builds, without faking a `CaptureJobRow`.

**Files:**
- Modify: `src/lib/capture-job-runner.ts` (the `buildSaveInput` function, ~lines 240–385)

**Interfaces:**
- Produces:

```ts
export type ParseSaveContext = {
  userId: string;
  result: CaptureParseResult;          // from "@/lib/capture/types"
  decisions: CaptureDecisions | null;  // from "@/lib/capture/types"
  sourceText: string;
  sourceHash: string | null;
  entryPoint: SaveNoteBatchInput["entryPoint"];
  seedContactId: string | null;
  inputSources: CaptureSourceKind[];   // from "@/db/schema"
  meetingSessionId: string | null;
};
export async function saveInputFromParse(ctx: ParseSaveContext): Promise<SaveNoteBatchInput>;
```

- `buildSaveInput(row)` keeps its signature and becomes a thin call to `saveInputFromParse`.

- [ ] **Step 1: Baseline the capture smokes** (they are the test for a refactor). Find them: `ls scripts | grep -i capture` and run each pglite one that exercises save, at minimum `npx tsx scripts/smoke-capture-jobs.ts` and any `smoke-capture-job-runner*.ts` / `smoke-note-batch*.ts` that exist. Record that they pass before the change.

- [ ] **Step 2: Refactor.** Move the body of `buildSaveInput` into `saveInputFromParse(ctx)`, replacing each `row.*` read:

| was | becomes |
|---|---|
| `row.result!` | `ctx.result` |
| `row.decisions ?? {}` | `ctx.decisions ?? {}` |
| `row.userId` | `ctx.userId` |
| `row.meetingSessionId` | `ctx.meetingSessionId` |
| `row.sourceText!` | `ctx.sourceText` |
| `row.sourceHash ?? hashSourceNote(row.sourceText!)` | `ctx.sourceHash ?? hashSourceNote(ctx.sourceText)` |
| `row.entryPoint` | `ctx.entryPoint` |
| `row.seedContactId` | `ctx.seedContactId` |
| `captureSourceKinds([...row.sources, …])` | `ctx.inputSources` |

Then:

```ts
export async function buildSaveInput(row: CaptureJobRow): Promise<SaveNoteBatchInput> {
  return saveInputFromParse({
    userId: row.userId,
    result: row.result!,
    decisions: row.decisions ?? null,
    sourceText: row.sourceText!,
    sourceHash: row.sourceHash ?? null,
    entryPoint: row.entryPoint,
    seedContactId: row.seedContactId,
    // For the history's icons: what the notes arrived as. Typed text carries no label.
    inputSources: captureSourceKinds([
      ...row.sources,
      ...(row.photoIds.length ? ["photos"] : []),
      ...(row.sourceKind === "voice" ? ["voice"] : []),
    ]),
    meetingSessionId: row.meetingSessionId,
  });
}
```

Add a doc comment on `saveInputFromParse`: "Decisions → what `saveNoteBatch` writes, for any caller holding a parse result. `buildSaveInput` is the capture-job wrapper; the Drive import calls this directly."

- [ ] **Step 3: Run** the same capture smokes → identical pass. `npx tsc --noEmit` clean.

- [ ] **Step 4: Commit** — "Let other importers build a capture save from a parse result".

---

### Task 6: The `drive_docs` import type, staging and processor

**Files:**
- Create: `src/lib/drive-import-type.ts`
- Modify: `src/db/schema.ts` (types only: `DriveFileRowPayload`, `ImportJobRowPayload` union, `isDriveFileRow`, `ImportStats` fields)
- Create: `src/lib/drive-import-processor.ts`
- Modify: `src/lib/import-job-dispatch.ts`
- Modify: `src/lib/imports/import-people.ts`
- Test: create `scripts/smoke-drive-import.ts` (register `"pglite"`, timeout 3 min in the timeouts map next to `smoke-import-engine`); modify `scripts/smoke-import-people.ts`

**Interfaces:**
- Consumes: `applyDriveReminderRules`, `followUpStillAhead`, `DriveFlag` (Task 2); `PickedDriveFile`, `DRIVE_MIME` (Task 3); `exportDriveFileText`, `DriveFileUnavailableError`, `DriveFileTooLargeError` (Task 4); `saveInputFromParse` (Task 5); `runCaptureParse`, `NO_PEOPLE_OR_DATES_MESSAGE` from `@/lib/capture-parse`; `saveNoteBatch` from `@/lib/note-batch-save`; `defaultMergeId` from `@/lib/capture/review-reducer`; `hashSourceNote` from `@/lib/suggested-reminder-utils`; `getValidAccessToken` from `@/lib/gmail`; `failImport`, `truncateStoredError` from `@/lib/import-job-processor`; `DEFAULT_FOLLOW_UP_WINDOW_DAYS` from `@/lib/note-batches`.
- Produces:
  - `DRIVE_IMPORT_TYPE = "drive_docs"`, `MAX_DRIVE_FILES_PER_IMPORT = 25`
  - `type DriveFileRowPayload = { kind: "drive_file"; fileId: string; name: string; mimeType: string; modifiedTime: string; contactIds?: string[] }`
  - `ImportStats` gains `docsRead?: number; docsAlreadyImported?: number; flaggedCommitments?: StoredDriveFlag[]` where `StoredDriveFlag = DriveFlag & { id: string; contactId: string | null; docName: string }`
  - `stageDriveImport(userId: string, files: PickedDriveFile[]): Promise<{ importId: string; totalRows: number }>`
  - `type DriveImportDeps = { getAccessToken; exportText; parse; save; continueLater; now: () => Date }`
  - `runDriveImportJob(importId: string, deps?: DriveImportDeps): Promise<void>`
  - `DRIVE_ROW_COPY` (per-row skip reasons)

- [ ] **Step 1: Types.** Create `src/lib/drive-import-type.ts`:

```ts
/**
 * The Drive import's `import_type`, alone in an import-free module for the same reason as
 * `gmail-scan-type.ts`: `import-job-dispatch.ts` reads it at module scope and sits in a
 * cycle with the processors, so the constant must never be mid-initialisation.
 */
export const DRIVE_IMPORT_TYPE = "drive_docs";
```

In `src/db/schema.ts`, next to `GmailSenderRowPayload`:

```ts
/** One picked Google Doc or Slides deck in a Drive import. `contactIds` is written on success. */
export type DriveFileRowPayload = {
  kind: "drive_file";
  fileId: string;
  name: string;
  mimeType: string;
  /** ISO. Also the date anchor for the parse: "next Tuesday" means next from when it was written. */
  modifiedTime: string;
  /** Everyone the doc's save touched. The row's own `contact_id` holds only the first. */
  contactIds?: string[];
};
```

Add `| DriveFileRowPayload` to `ImportJobRowPayload`, and:

```ts
export function isDriveFileRow(payload: ImportJobRowPayload): payload is DriveFileRowPayload {
  return payload.kind === "drive_file";
}
```

In `ImportStats`, after the Gmail scan block:

```ts
  // --- Google Drive import ---
  docsRead?: number;
  /** Docs skipped because the same text was already saved from an earlier import. */
  docsAlreadyImported?: number;
  /**
   * Past-due commitments worth a look (see `drive-reminder-rules.ts`). Shown in the import's
   * detail sheet; nothing is written for one unless the person makes it a reminder.
   */
  flaggedCommitments?: {
    id: string;
    key: string;
    title: string;
    personName: string | null;
    contactId: string | null;
    dueDateIso: string;
    sourceExcerpt: string;
    actionKind: ReminderActionKind;
    docName: string;
  }[];
```

Run `npx tsc --noEmit` — fix any exhaustive switch over `payload.kind` it flags (e.g. `nameFromRowPayload` in `src/actions/imports.ts` reads `p.name` generically, so it already covers `drive_file`).

- [ ] **Step 2: Write the failing test** `scripts/smoke-drive-import.ts`:

```ts
/**
 * The Drive import processor, end to end against PGlite with Drive and the model stubbed.
 *
 * Pins: staging caps and filters types; a doc becomes contacts + an interaction through
 * capture's own save; reminders obey the strict rules and a flag lands on the import; an
 * unchanged doc re-imported is skipped, not double-logged; a vanished file is skipped with
 * a plain reason and the job still completes; a time budget hand-off resumes where it stopped.
 *
 * Run: npx tsx scripts/smoke-drive-import.ts
 */
import "./smoke/_env";

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, importJobRows, imports, interactions, noteBatches, reminders } from "../src/db/schema";
import { ensureUserSettings } from "../src/lib/user-settings";
import {
  DRIVE_ROW_COPY,
  MAX_DRIVE_FILES_PER_IMPORT,
  runDriveImportJob,
  stageDriveImport,
  type DriveImportDeps,
} from "../src/lib/drive-import-processor";
import { DriveFileUnavailableError } from "../src/lib/drive";
import { DRIVE_MIME } from "../src/lib/imports/drive-triage";
import { saveNoteBatch } from "../src/lib/note-batch-save";
import type { CaptureParseResult, SuggestedReminderPreview } from "../src/lib/capture/types";
import { countImportPeople } from "../src/lib/imports/import-people";

const USER = "smoke-drive-import-user";
const NOW = new Date("2026-09-21T12:00:00Z");

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(noteBatches).where(eq(noteBatches.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(imports).where(eq(imports.userId, USER));
}

function reminder(key: string, over: Partial<SuggestedReminderPreview>): SuggestedReminderPreview {
  return {
    key, title: `Follow through ${key}`, description: null, rawDatePhrase: "on a date",
    dueDateIso: "2026-10-03", yearInferred: false, personName: "Priya Raman", actionKind: "task",
    confidenceScore: 90, sourceExcerpt: "…", dateBasis: "absolute", anchorIso: "2026-09-01",
    origin: "explicit", rationale: null, ...over,
  };
}

/** A minimal parse result naming one or two people. Shape copied from `CaptureParseResult`. */
function parsed(text: string, names: string[], suggested: SuggestedReminderPreview[]): CaptureParseResult {
  return {
    items: names.map((name, i) => ({
      key: `p${i}`,
      notes: text,
      parsed: {
        name, company: null, role: null, met_at: null, summary: `Met ${name}`, email: null,
        linkedin_url: null, tags: [], action_items: [], relationship_score_suggestion: 3,
        relevance: "medium", follow_up_recommendation: null, follow_up_days: null,
      },
      duplicates: [], suggestedMergeId: null, sharedNoteTexts: [],
      interactionDate: "2026-09-01", interactionType: "meeting",
    })) as unknown as CaptureParseResult["items"],
    sharedNotes: [], interactionDate: "2026-09-01", interactionType: "meeting",
    anchorIso: "2026-09-01", anchorBasis: "hint", hints: {}, sourceText: text,
    sourceHash: "", suggestedReminders: suggested,
    suggestionsSkipped: { relative: 0, unverifiable: 0, past: 0 },
    mentions: [], mentionedOnly: [],
  } as unknown as CaptureParseResult;
}

const DOCS: Record<string, { text: string; names: string[]; reminders: SuggestedReminderPreview[] } | "gone"> = {
  a: {
    text: "1:1 with Priya and Marco. Priya sends the deck on October 3.",
    names: ["Priya Raman", "Marco Bellini"],
    reminders: [
      reminder("future", {}),
      reminder("past-important", { dueDateIso: "2026-09-10", confidenceScore: 95 }),
      reminder("implied", { origin: "implied", rawDatePhrase: null }),
    ],
  },
  b: { text: "Coffee with Lena Okafor.", names: ["Lena Okafor"], reminders: [] },
  gone: "gone",
};

function deps(over: Partial<DriveImportDeps> = {}): DriveImportDeps & { continued: string[] } {
  const continued: string[] = [];
  return {
    continued,
    getAccessToken: async () => "tok",
    exportText: async (_t, fileId) => {
      const d = DOCS[fileId];
      if (!d || d === "gone") throw new DriveFileUnavailableError();
      return d.text;
    },
    parse: async (_u, text) => {
      const d = Object.values(DOCS).find((x) => x !== "gone" && x.text === text);
      if (!d || d === "gone") throw new Error("unexpected text");
      return parsed(text, d.names, d.reminders);
    },
    save: saveNoteBatch,
    continueLater: async (id) => void continued.push(id),
    now: () => NOW,
    ...over,
  };
}

const file = (id: string, mimeType: string = DRIVE_MIME.doc) => ({
  id, name: `Doc ${id}`, mimeType, modifiedTime: "2026-09-01T10:00:00Z",
});

async function main() {
  await reset();
  await ensureUserSettings(USER);
  const db = await getDb();

  // Staging: types filtered, cap enforced.
  const tooMany = Array.from({ length: MAX_DRIVE_FILES_PER_IMPORT + 1 }, (_, i) => file(`n${i}`));
  let capped = false;
  try { await stageDriveImport(USER, tooMany); } catch { capped = true; }
  check("more than the cap is refused", capped);

  const staged = await stageDriveImport(USER, [
    file("a"), file("b"), file("gone"), file("sheet", "application/vnd.google-apps.spreadsheet"),
  ]);
  check("a sheet is not staged", staged.totalRows === 3, String(staged.totalRows));

  const d1 = deps();
  await runDriveImportJob(staged.importId, d1);

  const imp = await db.query.imports.findFirst({ where: eq(imports.id, staged.importId) });
  check("the job completes", imp?.status === "completed", imp?.status);
  check("two docs read", imp?.stats?.docsRead === 2, JSON.stringify(imp?.stats));

  const rows = await db.query.importJobRows.findMany({ where: eq(importJobRows.importId, staged.importId) });
  const byFile = new Map(rows.map((r) => [(r.payload as { fileId: string }).fileId, r]));
  check("a vanished file is skipped", byFile.get("gone")?.status === "skipped");
  check("…with a plain reason", byFile.get("gone")?.errorMessage === DRIVE_ROW_COPY.unavailable);
  const aRow = byFile.get("a")!;
  const aIds = (aRow.payload as { contactIds?: string[] }).contactIds ?? [];
  check("doc a touched both people", aIds.length === 2 && aRow.contactId === aIds[0], JSON.stringify(aIds));

  const people = await countImportPeople(USER, staged.importId, imp!.createdAt);
  check("people list sees all three", people.added === 3, JSON.stringify(people));

  const rs = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
  const titles = rs.map((r) => r.title);
  check("the future stated date became a reminder", titles.includes("Follow through future"), JSON.stringify(titles));
  check("the implied one did not", !titles.includes("Follow through implied"));
  check("the past one did not", !titles.includes("Follow through past-important"));
  check("no reminder is already overdue (the Sep 1 follow-up would be due Sep 15)",
    rs.every((r) => !r.dueDate || r.dueDate.getTime() >= new Date("2026-09-21T00:00:00Z").getTime()),
    JSON.stringify(rs.map((r) => [r.title, r.dueDate])));
  const flags = imp?.stats?.flaggedCommitments ?? [];
  check("the past important one is flagged", flags.length === 1 && flags[0].key === "past-important");
  check("the flag knows its person", Boolean(flags[0]?.contactId));

  const interactionsBefore = await db.query.interactions.findMany({ where: eq(interactions.userId, USER) });

  // Re-import the same, unchanged doc: skipped, nothing doubled.
  const again = await stageDriveImport(USER, [file("a")]);
  await runDriveImportJob(again.importId, deps());
  const imp2 = await db.query.imports.findFirst({ where: eq(imports.id, again.importId) });
  check("an unchanged doc is recognised", imp2?.stats?.docsAlreadyImported === 1, JSON.stringify(imp2?.stats));
  const interactionsAfter = await db.query.interactions.findMany({ where: eq(interactions.userId, USER) });
  check("no interaction doubled", interactionsAfter.length === interactionsBefore.length);
  const people2 = await countImportPeople(USER, again.importId, imp2!.createdAt);
  check("the re-import still lists its people", people2.existing === 2, JSON.stringify(people2));

  // No AI key: the job stops at the first doc with one clear reason, rows left pending.
  const nokey = await stageDriveImport(USER, [file("b")]);
  const { AiAccessError } = await import("../src/lib/ai-access");
  await runDriveImportJob(nokey.importId, deps({
    parse: async () => { throw new AiAccessError("key_required"); },
  }));
  const nk = await db.query.imports.findFirst({ where: eq(imports.id, nokey.importId) });
  check("no AI key fails the job", nk?.status === "failed", nk?.status);

  // Time budget: a clock past the budget hands off without touching rows.
  const later = await stageDriveImport(USER, [file("b")]);
  let t = NOW.getTime();
  const d3 = deps({ now: () => new Date((t += 10 * 60_000)) });
  await runDriveImportJob(later.importId, d3);
  check("out of time → scheduled a continuation", d3.continued.includes(later.importId));
  const still = await db.query.importJobRows.findMany({
    where: and(eq(importJobRows.importId, later.importId), inArray(importJobRows.status, ["pending"])),
  });
  check("…and left the row pending", still.length === 1);

  await reset();
  console.log("smoke-drive-import: all checks passed");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await reset().catch(() => {});
  process.exit(1);
});
```

(If `CaptureParseResult["items"][number]`'s real shape needs more fields than the stub gives, read `BulkNotePersonPreview` in `src/lib/capture/types.ts` and add them to the stub — keep the casts, don't loosen the processor.)

- [ ] **Step 3: Run — expect FAIL** (module not found). `npx tsx scripts/smoke-drive-import.ts`

- [ ] **Step 4: Implement** `src/lib/drive-import-processor.ts`:

```ts
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  imports,
  importJobRows,
  noteBatches,
  isDriveFileRow,
  type DriveFileRowPayload,
  type ImportStats,
} from "@/db/schema";
import { classifyAiError, friendlyError, UserFacingError } from "@/lib/errors";
import { isAiAccessError } from "@/lib/ai-access";
import { internalFetch } from "@/lib/internal-auth";
import { reportError } from "@/lib/report-error";
import { failImport, truncateStoredError } from "@/lib/import-job-processor";
import { getValidAccessToken } from "@/lib/gmail";
import {
  DriveFileTooLargeError,
  DriveFileUnavailableError,
  exportDriveFileText,
} from "@/lib/drive";
import { NO_PEOPLE_OR_DATES_MESSAGE, runCaptureParse } from "@/lib/capture-parse";
import { saveNoteBatch } from "@/lib/note-batch-save";
import { saveInputFromParse } from "@/lib/capture-job-runner";
import { defaultMergeId } from "@/lib/capture/review-reducer";
import type { CaptureDecisions } from "@/lib/capture/types";
import { hashSourceNote } from "@/lib/suggested-reminder-utils";
import { DEFAULT_FOLLOW_UP_WINDOW_DAYS } from "@/lib/note-batches";
import {
  applyDriveReminderRules,
  followUpStillAhead,
} from "@/lib/imports/drive-reminder-rules";
import { DRIVE_MIME, type PickedDriveFile } from "@/lib/imports/drive-triage";
import { DRIVE_IMPORT_TYPE } from "@/lib/drive-import-type";

export { DRIVE_IMPORT_TYPE };

export const MAX_DRIVE_FILES_PER_IMPORT = 25;
/** Each row is an export plus a multi-call parse (~60 s for a busy doc), so a few per pass. */
const CHUNK_SIZE = 4;
/** Same headroom as the other runners: stay under the 300 s ceiling with room to hand off. */
const TIME_BUDGET_MS = 4.5 * 60 * 1000;
const MAX_STORED_FLAGS = 20;

/** Per-row reasons, stored on `import_job_rows.error_message` and shown in the detail sheet. */
export const DRIVE_ROW_COPY = {
  unavailable: "Orbit can’t open this file any more — it may have been deleted or unshared",
  tooLarge: "This file is too long to read as notes",
  empty: "Nothing written in this one",
  nobody: "No people or dates in this one",
  alreadyImported: "Already brought in — unchanged since",
  unreadable: "Orbit couldn’t read this one",
  noAiKey: "Add an AI key in Settings so Orbit can read your Drive files",
} as const;

export const DRIVE_KEY_PROBLEM_COPY = {
  auth: "Your AI provider didn’t accept your API key — check it in Settings, then try again",
  quota: "Your AI provider says your account is out of credit — top up with them, then try again",
  model_unavailable: "Your AI model isn’t available — pick another in Settings, then try again",
} as const;

export type DriveImportDeps = {
  getAccessToken: (userId: string, opts?: { minValidityMs?: number }) => Promise<string>;
  exportText: (accessToken: string, fileId: string) => Promise<string>;
  parse: typeof runCaptureParse;
  save: typeof saveNoteBatch;
  continueLater: (importId: string) => Promise<void>;
  now: () => Date;
};

async function scheduleContinuation(importId: string) {
  try {
    await internalFetch(`/api/imports/${importId}/continue`, { method: "POST" });
  } catch (err) {
    // Best-effort — the process-stalled cron picks the job back up either way.
    reportError(err, { where: "job.drive-import.continuation-kick", level: "warning", extra: { importId } });
  }
}

const DEFAULT_DEPS: DriveImportDeps = {
  getAccessToken: getValidAccessToken,
  exportText: (token, fileId) => exportDriveFileText(token, fileId),
  parse: runCaptureParse,
  save: saveNoteBatch,
  continueLater: scheduleContinuation,
  now: () => new Date(),
};

const SUPPORTED = new Set<string>([DRIVE_MIME.doc, DRIVE_MIME.slides]);

/** Create the import and one pending row per supported file. Nothing is fetched yet. */
export async function stageDriveImport(
  userId: string,
  files: PickedDriveFile[],
): Promise<{ importId: string; totalRows: number }> {
  const usable = files.filter((f) => SUPPORTED.has(f.mimeType));
  if (usable.length > MAX_DRIVE_FILES_PER_IMPORT) {
    throw new UserFacingError(`Pick up to ${MAX_DRIVE_FILES_PER_IMPORT} files at a time`);
  }
  if (!usable.length) throw new UserFacingError("Pick a Google Doc or Slides deck to import");

  const db = await getDb();
  const [row] = await db
    .insert(imports)
    .values({
      userId,
      importType: DRIVE_IMPORT_TYPE,
      status: "processing",
      totalRows: usable.length,
      rowsProcessed: 0,
      fileName: usable.length === 1 ? usable[0].name : `${usable.length} Google Drive files`,
      stats: {},
    })
    .returning();

  await db.insert(importJobRows).values(
    usable.map((f, i) => ({
      importId: row.id,
      userId,
      rowIndex: i,
      status: "pending",
      payload: {
        kind: "drive_file",
        fileId: f.id,
        name: f.name,
        mimeType: f.mimeType,
        modifiedTime: f.modifiedTime,
      } satisfies DriveFileRowPayload,
    })),
  );

  return { importId: row.id, totalRows: usable.length };
}

/** Every person the parse found, accepted into their best existing match — no review step. */
function acceptEveryone(
  items: Awaited<ReturnType<typeof runCaptureParse>>["items"],
  keep: string[],
  at: string,
): CaptureDecisions {
  const people: NonNullable<CaptureDecisions["people"]> = {};
  items.forEach((item, index) => {
    people[item.key] = {
      decision: "accept",
      index,
      mergeContactId: defaultMergeId(item),
      relationshipScore: item.parsed.relationship_score_suggestion ?? 3,
      tagNames: item.parsed.tags ?? [],
      decidedAt: at,
    };
  });
  return { people, reminders: { checked: keep, overrides: {} } };
}

/** A saved batch for exactly this text, from any earlier import or capture. */
async function priorBatchFor(userId: string, sourceHash: string) {
  const db = await getDb();
  return (
    (await db.query.noteBatches.findFirst({
      where: and(
        eq(noteBatches.userId, userId),
        eq(noteBatches.sourceHash, sourceHash),
        eq(noteBatches.status, "saved"),
      ),
      orderBy: [desc(noteBatches.createdAt)],
      columns: { result: true },
    })) ?? null
  );
}

type RowOutcome =
  | { status: "done"; contactIds: string[]; read: boolean; flags: NonNullable<ImportStats["flaggedCommitments"]>; reminders: number; created: number; updated: number }
  | { status: "skipped"; reason: string; already?: boolean; contactIds?: string[] };

async function processDoc(
  userId: string,
  payload: DriveFileRowPayload,
  accessToken: string,
  deps: DriveImportDeps,
): Promise<RowOutcome> {
  let text: string;
  try {
    text = await deps.exportText(accessToken, payload.fileId);
  } catch (err) {
    if (err instanceof DriveFileUnavailableError) return { status: "skipped", reason: DRIVE_ROW_COPY.unavailable };
    if (err instanceof DriveFileTooLargeError) return { status: "skipped", reason: DRIVE_ROW_COPY.tooLarge };
    throw err;
  }
  if (!text.trim()) return { status: "skipped", reason: DRIVE_ROW_COPY.empty };

  const sourceHash = hashSourceNote(text);
  const prior = await priorBatchFor(userId, sourceHash);
  if (prior) {
    return {
      status: "skipped",
      reason: DRIVE_ROW_COPY.alreadyImported,
      already: true,
      contactIds: (prior.result?.participants ?? []).map((p) => p.contactId),
    };
  }

  const now = deps.now();
  let result;
  try {
    // The doc's own date is the anchor, so "next Tuesday" in an old doc means next from then.
    result = await deps.parse(userId, text, { eventDate: payload.modifiedTime.slice(0, 10) }, { now });
  } catch (err) {
    if (err instanceof UserFacingError && err.message === NO_PEOPLE_OR_DATES_MESSAGE) {
      return { status: "skipped", reason: DRIVE_ROW_COPY.nobody };
    }
    throw err;
  }

  const { keep, flags } = applyDriveReminderRules(result.suggestedReminders, now);
  const input = await saveInputFromParse({
    userId,
    result,
    decisions: acceptEveryone(result.items, keep, now.toISOString()),
    sourceText: text,
    sourceHash,
    entryPoint: "capture",
    seedContactId: null,
    inputSources: ["file"],
    meetingSessionId: null,
  });
  // Rule 1 applies to the generic follow-up too: for an old doc it is already overdue.
  input.participants = input.participants.map((p) => ({
    ...p,
    createReminder:
      p.createReminder &&
      followUpStillAhead(
        input.anchorIso,
        p.followUpDays || p.parsed.follow_up_days || DEFAULT_FOLLOW_UP_WINDOW_DAYS,
        now,
      ),
  }));
  if (!input.participants.length && !input.commitments.length) {
    return { status: "skipped", reason: DRIVE_ROW_COPY.nobody };
  }

  const out = await deps.save(userId, input);
  const idByName = new Map(out.result.participants.map((p) => [p.name.trim().toLowerCase(), p.contactId]));
  return {
    status: "done",
    contactIds: out.contactIds,
    read: true,
    reminders: out.remindersCreated,
    created: out.created,
    updated: out.updated,
    flags: flags.map((f) => ({
      ...f,
      id: `${payload.fileId}:${f.key}`,
      contactId: f.personName ? (idByName.get(f.personName.trim().toLowerCase()) ?? null) : null,
      docName: payload.name,
    })),
  };
}

function keyProblem(err: unknown): string | null {
  // No usable AI key at all: every doc would hit the same wall, so the job stops at the first.
  if (isAiAccessError(err)) return friendlyError(err, DRIVE_ROW_COPY.noAiKey);
  const kind = classifyAiError(err);
  if (kind === "auth" || kind === "quota" || kind === "model_unavailable") {
    return friendlyError(err, DRIVE_KEY_PROBLEM_COPY[kind]);
  }
  return null;
}

export async function runDriveImportJob(
  importId: string,
  deps: DriveImportDeps = DEFAULT_DEPS,
): Promise<void> {
  const db = await getDb();
  const jobStart = deps.now().getTime();

  const importRow = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
  if (!importRow) return;
  if (["completed", "failed", "cancelled"].includes(importRow.status)) return;
  const userId = importRow.userId;

  let accessToken: string;
  try {
    accessToken = await deps.getAccessToken(userId, { minValidityMs: TIME_BUDGET_MS + 60_000 });
  } catch (err) {
    await failImport(importId, err);
    return;
  }

  try {
    for (;;) {
      if (deps.now().getTime() - jobStart > TIME_BUDGET_MS) {
        await deps.continueLater(importId);
        return;
      }
      // Re-read so a cancel from the UI takes effect between chunks.
      const current = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
      if (!current || current.status !== "processing") return;

      const pending = await db.query.importJobRows.findMany({
        where: and(eq(importJobRows.importId, importId), eq(importJobRows.status, "pending")),
        orderBy: [asc(importJobRows.rowIndex)],
        limit: CHUNK_SIZE,
      });
      if (!pending.length) break;

      const stats: ImportStats = { ...(current.stats ?? {}) };
      // Nullable columns: `?? 0`, not destructuring defaults, which only catch undefined.
      let contactsCreated = current.contactsCreated ?? 0;
      let contactsUpdated = current.contactsUpdated ?? 0;
      let rowsProcessed = current.rowsProcessed ?? 0;

      for (const row of pending) {
        if (deps.now().getTime() - jobStart > TIME_BUDGET_MS) break;
        const payload = row.payload;
        if (!isDriveFileRow(payload)) {
          await db.update(importJobRows).set({ status: "skipped", updatedAt: new Date() }).where(eq(importJobRows.id, row.id));
          rowsProcessed++;
          continue;
        }

        let outcome: RowOutcome;
        try {
          outcome = await processDoc(userId, payload, accessToken, deps);
        } catch (err) {
          const problem = keyProblem(err);
          if (problem) {
            await failImport(importId, new Error(problem));
            return;
          }
          reportError(err, { where: "job.drive-import.row", level: "warning", extra: { importId } });
          outcome = { status: "skipped", reason: DRIVE_ROW_COPY.unreadable };
        }

        if (outcome.status === "done") {
          stats.docsRead = (stats.docsRead ?? 0) + 1;
          stats.remindersCreated = (stats.remindersCreated ?? 0) + outcome.reminders;
          stats.flaggedCommitments = [...(stats.flaggedCommitments ?? []), ...outcome.flags].slice(0, MAX_STORED_FLAGS);
          contactsCreated += outcome.created;
          contactsUpdated += outcome.updated;
        } else if (outcome.already) {
          stats.docsAlreadyImported = (stats.docsAlreadyImported ?? 0) + 1;
        }

        const contactIds = outcome.status === "done" ? outcome.contactIds : (outcome.contactIds ?? []);
        await db
          .update(importJobRows)
          .set({
            // An unchanged re-import is recorded as done: it touched these people, and the
            // detail sheet should list them. Its reason is kept for the row view.
            status: outcome.status === "done" || outcome.already ? "done" : "skipped",
            contactId: contactIds[0] ?? null,
            payload: { ...payload, contactIds },
            errorMessage: outcome.status === "skipped" ? truncateStoredError(outcome.reason) : null,
            updatedAt: new Date(),
          })
          .where(eq(importJobRows.id, row.id));
        rowsProcessed++;
      }

      await db
        .update(imports)
        .set({ rowsProcessed, contactsCreated, contactsUpdated, stats, updatedAt: new Date() })
        .where(eq(imports.id, importId));
    }

    await db
      .update(imports)
      .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(imports.id, importId), eq(imports.status, "processing")));
  } catch (err) {
    await failImport(importId, err);
  }
}
```

Notes for the implementer:
- Check `imports` has a `completedAt` column (`grep -n completedAt src/db/schema.ts`); if not, drop that field from the final update.
- `sql` is imported for parity with siblings; remove it if eslint flags it unused.
- `interactionsLogged`: if `SaveNoteBatchOutput` does not report interactions, leave it unset — the summary chips (Task 8) use `docsRead` and contacts for this type.

- [ ] **Step 5: Register the processor.** In `src/lib/import-job-dispatch.ts`:

```ts
import { DRIVE_IMPORT_TYPE } from "@/lib/drive-import-type";
import { runDriveImportJob } from "@/lib/drive-import-processor";
```

add `DRIVE_IMPORT_TYPE,` to `RESUMABLE_IMPORT_TYPES`, and in the switch:

```ts
    case DRIVE_IMPORT_TYPE:
      return runDriveImportJob(importId);
```

- [ ] **Step 6: People list covers every person.** In `src/lib/imports/import-people.ts`, replace `importContactIds`:

```ts
function importContactIds(userId: string, importId: string) {
  return sql`
    SELECT r.contact_id FROM import_job_rows r
    WHERE r.import_id = ${importId}
      AND r.user_id = ${userId}
      AND r.status = 'done'
      AND r.contact_id IS NOT NULL
    UNION
    SELECT (jsonb_array_elements_text(r.payload->'contactIds'))::uuid
    FROM import_job_rows r
    WHERE r.import_id = ${importId}
      AND r.user_id = ${userId}
      AND r.status = 'done'
      AND jsonb_typeof(r.payload->'contactIds') = 'array'
  `;
}
```

Extend the header comment: "A Drive doc names several people but its row holds one `contact_id`; the rest ride `payload.contactIds`, which the second arm reads." In `scripts/smoke-import-people.ts`, add a row whose `contact_id` is null and `payload` is `{ contactIds: [<a new after-contact id>] }` with status `done`, and assert `countImportPeople` now reports `added === 2` for the first scenario (update the existing expectation and the paging arithmetic accordingly).

- [ ] **Step 7: Run.** `npx tsx scripts/smoke-drive-import.ts` and `npx tsx scripts/smoke-import-people.ts` → all ok. Register `"smoke-drive-import": "pglite"` in `MANIFEST` and give it `3 * 60_000` in the timeouts map. `npx tsx scripts/smoke-import-engine.ts` and `npx tsx scripts/smoke-admin-actions.ts` still pass (dispatch changed). tsc + eslint.

- [ ] **Step 8: Commit** — "Add the drive_docs import: stage picked files, read each through capture's save".

---

### Task 7: Server actions

**Files:**
- Create: `src/actions/drive.ts`
- Create: `src/lib/drive-flags.ts` (the flag removal logic, userId-scoped, so it's smoke-testable)
- Test: extend `scripts/smoke-drive-import.ts`

**Interfaces:**
- Consumes: `stageDriveImport`, `PickedDriveFile`, `grantCovers`, `getValidAccessToken`, `requireSyncUser` (`@/lib/plan-guards`), `asActionResult` (`@/lib/errors` — read its signature before use).
- Produces:
  - `getDrivePickerToken(): Promise<{ ok: true; accessToken: string } | { ok: false; reason: "needs_consent" | "not_connected" | "error"; error?: string }>`
  - `startDriveImport(files: PickedDriveFile[]): Promise<{ importId: string; totalRows: number }>`
  - `dismissDriveFlag(importId: string, flagId: string): Promise<void>`
  - lib: `removeDriveFlag(userId: string, importId: string, flagId: string): Promise<boolean>`

- [ ] **Step 1: Failing test.** Append to `smoke-drive-import.ts` before `await reset()` at the end:

```ts
  // Dismissing a flag removes exactly that one, and only for its owner.
  const flagged = await db.query.imports.findFirst({ where: eq(imports.id, staged.importId) });
  const flagId = flagged!.stats!.flaggedCommitments![0].id;
  check("another user can't dismiss it", !(await removeDriveFlag("someone-else", staged.importId, flagId)));
  check("the owner can", await removeDriveFlag(USER, staged.importId, flagId));
  const after = await db.query.imports.findFirst({ where: eq(imports.id, staged.importId) });
  check("…and it's gone", (after!.stats!.flaggedCommitments ?? []).length === 0);
```

with `import { removeDriveFlag } from "../src/lib/drive-flags";` at the top. Run → FAIL.

- [ ] **Step 2: Implement** `src/lib/drive-flags.ts`:

```ts
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { imports } from "@/db/schema";

/** Remove one flagged commitment from an import the user owns. False when nothing matched. */
export async function removeDriveFlag(userId: string, importId: string, flagId: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.query.imports.findFirst({
    where: and(eq(imports.id, importId), eq(imports.userId, userId)),
    columns: { stats: true },
  });
  const flags = row?.stats?.flaggedCommitments ?? [];
  if (!row || !flags.some((f) => f.id === flagId)) return false;
  await db
    .update(imports)
    .set({ stats: { ...(row.stats ?? {}), flaggedCommitments: flags.filter((f) => f.id !== flagId) }, updatedAt: new Date() })
    .where(and(eq(imports.id, importId), eq(imports.userId, userId)));
  return true;
}
```

- [ ] **Step 3: Implement** `src/actions/drive.ts` — **async function exports only; no constants, no type re-exports**:

```ts
"use server";

import { after } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { gmailConnections } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import { requireSyncUser } from "@/lib/plan-guards";
import { grantCovers } from "@/lib/google-scopes";
import { getValidAccessToken } from "@/lib/gmail";
import { friendlyError } from "@/lib/errors";
import { runDriveImportJob, stageDriveImport } from "@/lib/drive-import-processor";
import { removeDriveFlag } from "@/lib/drive-flags";
import type { PickedDriveFile } from "@/lib/imports/drive-triage";

/**
 * A short-lived Google token for the Picker, which runs in the browser and cannot use the
 * encrypted token we store. Only ever for a grant that covers drive.file, so what reaches
 * the browser can open the Picker and nothing more. Returned as data, never thrown: a thrown
 * message is replaced by a digest in production.
 */
export async function getDrivePickerToken(): Promise<
  | { ok: true; accessToken: string }
  | { ok: false; reason: "needs_consent" | "not_connected" | "error"; error?: string }
> {
  const userId = await requireSyncUser();
  const db = await getDb();
  const conn = await db.query.gmailConnections.findFirst({
    where: eq(gmailConnections.userId, userId),
    columns: { scopes: true },
  });
  if (!conn) return { ok: false, reason: "not_connected" };
  if (!grantCovers("drive", conn.scopes)) return { ok: false, reason: "needs_consent" };
  try {
    return { ok: true, accessToken: await getValidAccessToken(userId, { minValidityMs: 10 * 60_000 }) };
  } catch (err) {
    return { ok: false, reason: "error", error: friendlyError(err, "Couldn’t reach Google — try again in a moment") };
  }
}

/** Stage the picked files and start reading them in the background. */
export async function startDriveImport(
  files: PickedDriveFile[],
): Promise<{ importId: string; totalRows: number }> {
  const userId = await requireSyncUser();
  const staged = await stageDriveImport(userId, files);
  after(() => runDriveImportJob(staged.importId));
  return staged;
}

/** Drop a flagged commitment from an import's "Worth a look" list. */
export async function dismissDriveFlag(importId: string, flagId: string): Promise<void> {
  const userId = await requireUserId();
  await removeDriveFlag(userId, importId, flagId);
}
```

Check how `startLinkedInImport` in `src/actions/imports.ts` kicks its runner (`after(...)` vs `internalFetch` continuation) and match it exactly. If `stageDriveImport` throws a `UserFacingError`, check whether sibling `start*` actions wrap with `asActionResult` so the message survives production; if they do, return `{ ok, … }` data the same way and adapt Task 8's runner call.

- [ ] **Step 4: Run** `npx tsx scripts/smoke-drive-import.ts` → ok. `grep -nE "^export (const|let|var|class|type \{) " src/actions/drive.ts` → **no output**. tsc + eslint.

- [ ] **Step 5: Commit** — "Add Drive picker token, start and flag-dismiss actions".

---

### Task 8: Runner kind, history and the "Worth a look" section

**Files:**
- Modify: `src/lib/import-job-runner.ts`
- Modify: `src/lib/imports/import-sources.ts`, `src/lib/imports/import-summary.ts`
- Modify: `src/components/imports/import-history.tsx`, `src/actions/imports.ts` (`ImportHistoryItem.stats` / `getImportDetail` pass through `docsRead`, `docsAlreadyImported`, `flaggedCommitments`)
- Test: `scripts/smoke-import-sources.ts` (auto — must pass once label + icon exist), `scripts/smoke-import-history-render.ts` (extend)

**Interfaces:**
- Consumes: `startDriveImport`, `dismissDriveFlag` (Task 7); `createReminder` from `@/actions/reminders` (signature: `{ contactId?, title, description?, dueDate?, reminderType?, listId?, actionKind? }`).
- Produces: `ImportJobKind` includes `"drive_docs"`; `ImportJobInput` gains `{ kind: "drive_docs"; files: PickedDriveFile[] }`.

- [ ] **Step 1: Failing tests.**
  - Run `npx tsx scripts/smoke-import-sources.ts` → FAIL: `drive_docs` has no label/icon (it scans `*-type.ts` — add `"src/lib/drive-import-type.ts"` to its file list at line ~34 first).
  - In `scripts/smoke-import-history-render.ts`, add a case: a `drive_docs` item with `contactsCreated: 2, contactsUpdated: 1, stats: { docsRead: 3, remindersCreated: 1, flaggedCommitments: [<one flag>] }` and assert the chips read `"3 docs read"`, `"2 added"`, `"1 updated"`, `"1 reminder"`, `"1 to look at"`, and that no chip contains `failed`.

- [ ] **Step 2: Implement.**
  - `import-sources.ts`: `drive_docs: "Google Drive",`
  - `import-history.tsx` `SOURCE_ICON`: `drive_docs: { icon: FileText, badge: CONNECTIONS_BADGE },` (import `FileText` from lucide-react).
  - `import-summary.ts`: extend `SummarisableImport.stats` with `docsRead?: number; flaggedCommitments?: unknown[]`, and in `summarizeImport` add, before the contacts chips:

```ts
  if (item.importType === "drive_docs") {
    add(stats.docsRead, (n) => `${n} doc${n === 1 ? "" : "s"} read`, "neutral");
  }
```

  and after the reminders chip:

```ts
  add(stats.flaggedCommitments?.length, (n) => `${n} to look at`, "offer", "#worth-a-look");
```

  - `import-job-runner.ts`: add `"drive_docs"` to `ImportJobKind` and `ServerOwnedKind`; `ImportJobInput` gains `| { kind: "drive_docs"; files: PickedDriveFile[] }` (type import from `@/lib/imports/drive-triage`); `importJobLabel` → `"Reading Google Drive files"`; the unit label for this kind is `"files"` with `total = input.files.length`; `completionMessage` for `drive_docs` leads with `` `${status.rowsProcessed} file${…} read` `` then the usual created/updated/reminders parts; and a branch in `startImportJob`:

```ts
      if (input.kind === "drive_docs") {
        await runServerOwnedImportJob(
          jobId,
          "drive_docs",
          label,
          total,
          () => startDriveImport(input.files),
          step,
        );
        return;
      }
```

  `tsc` will list every other exhaustive switch on `ImportJobKind` (e.g. `tabForImportJob` in the integrations dialog) — return `null` / the neutral case there.
  - `import-history.tsx` detail body: after the People section, render when `item.stats?.flaggedCommitments?.length`:

```tsx
        {flags.length ? (
          <div id="worth-a-look">
            <h3 className="text-sm font-medium">Worth a look</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              These dates had already passed, so Orbit didn’t make reminders for them
            </p>
            <ul className="mt-1.5 space-y-1.5">
              {flags.map((f) => (
                <li key={f.id} className="rounded-lg border border-border/60 px-3 py-2 text-xs">
                  <p className="font-medium">{f.title}</p>
                  <p className="text-muted-foreground">
                    {f.personName ? `${f.personName} · ` : ""}was due {f.dueDateIso} · {f.docName}
                  </p>
                  <div className="mt-1.5 flex gap-2">
                    <Button type="button" size="sm" variant="outline" disabled={busyFlag === f.id} onClick={() => remind(f)}>
                      Make a reminder
                    </Button>
                    <Button type="button" size="sm" variant="ghost" disabled={busyFlag === f.id} onClick={() => dismiss(f.id)}>
                      Dismiss
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
```

  with component state `const [flags, setFlags] = useState(item.stats?.flaggedCommitments ?? [])`, `busyFlag`, and handlers:

```ts
  async function remind(f: Flag) {
    setBusyFlag(f.id);
    try {
      await createReminder({
        contactId: f.contactId ?? undefined,
        title: f.title,
        description: f.sourceExcerpt,
        dueDate: new Date().toISOString(),
        actionKind: f.actionKind,
      });
      await dismissDriveFlag(item.id, f.id);
      setFlags((xs) => xs.filter((x) => x.id !== f.id));
      toast.success("Reminder made for today");
    } catch (err) {
      toast.error(friendlyError(err, "Couldn’t make that reminder — try again"));
    } finally {
      setBusyFlag(null);
    }
  }
```

  (`dismiss` is the same minus `createReminder`, toast `"Dismissed"`.) Check `createReminder`'s `dueDate` parsing in `src/actions/reminders.ts` and pass the format it expects. Pass `flaggedCommitments`, `docsRead`, `docsAlreadyImported` through `ImportHistoryItem.stats` / `getImportDetail` in `src/actions/imports.ts` — types for the flag come from `ImportStats` in `@/db/schema` (`NonNullable<ImportStats["flaggedCommitments"]>[number]`), never re-exported from the action file.

- [ ] **Step 3: Run** `smoke-import-sources`, `smoke-import-history-render`, `smoke-toast-copy`, `smoke-import-progress-card` → ok. tsc + eslint.

- [ ] **Step 4: Commit** — "Show Drive imports in history, with flagged dates worth a look".

---

### Task 9: Picker, card, wiring, CSP — and live verification

**Files:**
- Create: `src/lib/imports/google-picker.ts`
- Create: `src/components/imports/drive-import-card.tsx`
- Modify: `src/components/imports/import-dropzone.tsx`, `src/components/imports/import-hub.tsx`, `src/app/(clerk)/(app)/(main)/imports/page.tsx`
- Modify: `src/lib/security-headers.ts`, `scripts/smoke-security-headers.ts`
- Modify: `src/lib/imports/import-copy.ts` (new strings), `.env.example`
- Modify: `docs/superpowers/specs/2026-09-21-google-drive-import-design.md` (apply the five deviations listed at the top of this plan)

**Interfaces:**
- Consumes: `getDrivePickerToken`, `startGmailOAuth({ purpose: "drive", returnTo: "/imports" })`, `triageDriveFile`, `startImportJob({ kind: "drive_docs", files })`, `GmailConnectionStatus.canImportDrive`.
- Produces: `openDrivePicker(opts: { accessToken: string; apiKey: string; appId: string }): Promise<PickedDriveFile[]>`; `ImportDropzone` prop `extraAction?: React.ReactNode`.

- [ ] **Step 1: CSP test first.** In `scripts/smoke-security-headers.ts` add assertions that the built CSP contains `https://apis.google.com` in `script-src`, and `https://docs.google.com` + `https://drive.google.com` in `frame-src`, and that `connect-src` contains `https://www.googleapis.com`. Run → FAIL. Then add those hosts in `buildSecurityHeaders` (script-src: `"https://apis.google.com"`; frame-src: `"https://docs.google.com", "https://drive.google.com"`; connect-src: `"https://www.googleapis.com"`) with a comment "Google Picker for Drive imports". Run → ok.

- [ ] **Step 2: Picker loader** `src/lib/imports/google-picker.ts`:

```ts
"use client";

import { DRIVE_MIME, type PickedDriveFile } from "@/lib/imports/drive-triage";

/**
 * Google's file picker, loaded only when someone presses the Drive button.
 *
 * With `drive.file`, a file becomes readable to Orbit by being picked here — which is why the
 * App ID must be the same Google Cloud project as the OAuth client.
 */
type PickerDoc = { id: string; name: string; mimeType: string; lastEditedUtc?: number };
type GapiWindow = Window & {
  gapi?: { load: (lib: string, cb: () => void) => void };
  google?: { picker: any }; // eslint-disable-line @typescript-eslint/no-explicit-any -- Google ships no types
};

let loading: Promise<void> | null = null;

function loadPickerLibrary(): Promise<void> {
  const w = window as GapiWindow;
  if (w.google?.picker) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.async = true;
    script.onload = () => w.gapi!.load("picker", () => resolve());
    script.onerror = () => {
      loading = null;
      reject(new Error("Couldn’t load Google’s file picker"));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export async function openDrivePicker(opts: {
  accessToken: string;
  apiKey: string;
  appId: string;
}): Promise<PickedDriveFile[]> {
  await loadPickerLibrary();
  const { picker } = (window as GapiWindow).google!;
  return new Promise((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS)
      .setMimeTypes(`${DRIVE_MIME.doc},${DRIVE_MIME.slides}`)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false);
    new picker.PickerBuilder()
      .addView(view)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(opts.accessToken)
      .setDeveloperKey(opts.apiKey)
      .setAppId(opts.appId)
      .setMaxItems(25)
      .setCallback((data: { action: string; docs?: PickerDoc[] }) => {
        if (data.action === picker.Action.PICKED) {
          resolve(
            (data.docs ?? []).map((d) => ({
              id: d.id,
              name: d.name,
              mimeType: d.mimeType,
              modifiedTime: new Date(d.lastEditedUtc ?? Date.now()).toISOString(),
            })),
          );
        } else if (data.action === picker.Action.CANCEL) {
          resolve([]);
        }
      })
      .build()
      .setVisible(true);
  });
}
```

- [ ] **Step 3: The card** `src/components/imports/drive-import-card.tsx` — a client component that:
  - receives `files: PickedDriveFile[]` and `onDone: () => void`;
  - computes `triageDriveFile(f, new Date())` per file; initial selection = ids where `likely`;
  - renders a card styled like `ImportQueueCard` (read it and reuse its outer classes): heading "From Google Drive", one row per file with a checkbox (the same checkbox component `ImportPeopleReview` uses), the file name, a Docs/Slides label, and the `why` in muted text; a summary "`N of M` selected";
  - primary button `Import ${n} file${n === 1 ? "" : "s"}` → `startImportJob({ kind: "drive_docs", files: selected })` then `onDone()`; secondary "Cancel" → `onDone()`;
  - disabled while `useImportJob()` reports a running job, with the hint "Wait for the import that’s running to finish".

- [ ] **Step 4: Button + wiring.**
  - `ImportDropzone`: add optional `extraAction?: React.ReactNode`, rendered as a third item inside the buttons row.
  - `page.tsx`: pass to `ImportHub` a `drive` prop:

```ts
drive={{
  apiKey: process.env.NEXT_PUBLIC_GOOGLE_PICKER_API_KEY ?? null,
  appId: process.env.NEXT_PUBLIC_GOOGLE_APP_ID ?? null,
  connected: Boolean(gmail?.connected),
  canImportDrive: Boolean(gmail?.canImportDrive),
}}
```

  - `ImportHub`: when `drive.apiKey && drive.appId`, pass `extraAction` = a `Choose from Google Drive` button (`variant="outline"`, lucide `HardDrive` icon, `onClick` with `e.stopPropagation()`). When `!canUseSync`, render it disabled with title "Google Drive is on paid plans". Click handler:

```ts
async function pickFromDrive() {
  const token = await getDrivePickerToken();
  if (!token.ok) {
    if (token.reason === "needs_consent" || token.reason === "not_connected") {
      const { url } = await startGmailOAuth({ purpose: "drive", returnTo: "/imports" });
      window.location.assign(url);
      return;
    }
    toast.error(token.error ?? IMPORT_COPY.driveUnavailable);
    return;
  }
  try {
    const picked = await openDrivePicker({ accessToken: token.accessToken, apiKey: drive.apiKey!, appId: drive.appId! });
    if (picked.length) setDrivePicks(picked);
  } catch (err) {
    toast.error(friendlyError(err, IMPORT_COPY.driveUnavailable));
  }
}
```

  and render `<DriveImportCard files={drivePicks} onDone={() => setDrivePicks(null)} />` in place of `<ImportQueueCard />` while `drivePicks` is set.
  - `import-copy.ts`: `driveUnavailable: "Couldn’t open Google Drive — try again in a moment",` plus any card strings, so `smoke-toast-copy` checks them.
  - `.env.example`: document both vars as optional, next to the other `GOOGLE_*` lines.

- [ ] **Step 5: Gates.** `npx tsc --noEmit`; `npx eslint .` (0 errors); stop any dev server for this worktree, then `npm test` → all pass; `npx tsx scripts/run-smoke.ts --check`.

- [ ] **Step 6: Live verification.** This worktree has no `.env` (demo mode). Copy the two `NEXT_PUBLIC_GOOGLE_*` vars plus `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI` from the main checkout's `.env.local` into this worktree's `.env.local` **only if** the user agrees (it switches the worktree out of demo mode's local PGlite if `DATABASE_URL` comes along — do not copy `DATABASE_URL`). Start `orbit-web` via `preview_start`, then:
  1. `/imports` shows **Choose from Google Drive**; with the vars removed it does not.
  2. Clicking it without a Drive grant goes to Google consent asking only for Drive file access, and returns to `/imports`.
  3. The Picker opens showing Docs and Slides only; pick a notes doc, a template, and an "Untitled document" → the card pre-ticks only the notes doc, with reasons.
  4. Import → progress reads "Reading Google Drive files" → history shows a **Google Drive** row with "N docs read" chips; the detail sheet lists the people under Added; any flag appears under **Worth a look**, and **Make a reminder** creates one due today.
  5. Re-import the same unchanged doc → "Already brought in — unchanged since" in the row detail, no new meeting on the contact.
  6. No CSP violations in the console (`read_console_messages` with pattern `Content Security Policy`).
  Screenshot steps 3 and 4 for the user.

- [ ] **Step 7: Update the spec** with the five deviations at the top of this plan (sections 4, 5 and 6), and correct "0.85" → "85".

- [ ] **Step 8: Commit** — "Add the Choose from Google Drive button and picker". Then push the branch and open a PR against `main` noting it depends on #238 (or against `claude/imports-page-redesign-decdb0` if #238 hasn't merged).
