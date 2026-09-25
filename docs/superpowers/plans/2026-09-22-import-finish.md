# Import Finish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an import finishes, `/imports` shows a done card — a canvas swarm of the new people settling into orbit, one sentence of arithmetic, one strong next step — and the people it created can be undone for 7 days if nobody has touched them.

**Architecture:** Pure modules carry everything worth testing without a DOM or a database (scene geometry, the sentence, the fingerprint, the undo decision). The engine stamps per-row provenance into jsonb it already writes, so undo reads facts rather than guessing, with a derived fallback for older imports. The canvas is one rAF loop over a capped particle count. Undo deletes through the existing `deleteContactForUser`.

**Tech Stack:** Next.js 16 App Router (read `node_modules/next/dist/docs/` before touching routing/actions — this is NOT the Next.js you know), Drizzle over Neon/PGlite, canvas 2D, tsx smoke scripts via `scripts/run-smoke.ts`.

**Spec:** `docs/superpowers/specs/2026-09-22-import-finish-design.md`

## Global Constraints

- Branch: `claude/imports-page-redesign-decdb0` (PR #238). Task 1 merges `origin/main` first; everything else builds on that merge.
- **No DDL.** `import_job_rows.payload` and `imports.stats` are jsonb — provenance and undo records ride them. Do not bump `SCHEMA_VERSION` (the merge may bring a new value from main; leave whatever main sets).
- Swarm caps: **300 dots maximum**, **~12 faces**, **180px tall desktop / 120px phone**.
- Undo window: **7 days** from the import's creation.
- "Untouched" = no `contact_tags`, no `contacts.notes`, no `reminders`, no `interactions` beyond the import's own, not a winner in `contact_merges`, and the stored fingerprint still matches. **Never** use `contacts.updated_at` — `avatar-backfill.ts` and `contact-brief.ts` bump it on system writes.
- **`"use server"` files may export only async functions.** No `export const`, no `export type { … }` re-export specifiers (both silently kill every export in the module; neither `tsc` nor `next build` catches it). Shared constants and types go in `src/lib/`.
- Client components must not import `@/db` or server-only modules (the build fails with an unhelpful `node:fs` chunk error). Type-only imports are fine.
- House voice (enforced repo-wide by `scripts/smoke-toast-copy.ts`): curly apostrophe `’`, "Couldn’t" never "Could not", never the word "failed" in user copy, no trailing period, at most one ` — ` connector per line. Never render `err.message`; use `friendlyError(err, fallback)` / `UserFacingError`.
- Every new smoke script must be registered in `MANIFEST` in `scripts/run-smoke.ts` (tier `"pure"` or `"pglite"`); an unregistered script fails the whole suite. Every tsx script ends with `process.exit(0)`.
- **PGlite is single-writer:** stop any `next dev` for this worktree before a pglite smoke or `npm test` (`lsof -iTCP -sTCP:LISTEN -n -P | grep node`, then `lsof -p <pid> -a -d cwd -Fn`; never kill another worktree's server).
- Gates before every commit: `npx tsc --noEmit` clean; `npx eslint .` **0 errors** (warning baseline is whatever the merge leaves — record it in Task 1 and hold it).
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/lib/imports/import-provenance.ts` | create | Pure: the fingerprint, and the payload shape the engine stamps |
| `src/lib/imports/finish-scene-geometry.ts` | create | Pure: dot cap, ring placement, settle easing |
| `src/lib/imports/import-finish.ts` | create | Pure: the sentence, the button, the multi-file summary |
| `src/lib/imports/import-undo.ts` | create | Undo candidates, the untouched rule, preview and removal (userId-scoped) |
| `src/lib/import-engine.ts` | modify | Stamp provenance in `markRowsDone` |
| `src/actions/imports.ts` | modify | `getLatestFinishedImport`, `previewImportUndo`, `undoImport` |
| `src/components/imports/import-finish-scene.tsx` | create | The canvas and its lifecycle |
| `src/components/imports/import-finish-card.tsx` | create | The done card (scene + sentence + button + undo line) |
| `src/components/imports/import-queue-card.tsx` | modify | Render the done card in the `done` phase |
| `src/components/imports/import-history.tsx` | modify | Undo in the detail sheet; "Undone" on the row |
| `src/app/(clerk)/(app)/(main)/imports/page.tsx` | modify | Pass the latest finished import |
| `src/app/(clerk)/(app)/(main)/contacts/page.tsx` | modify | `importId` filter |
| `src/lib/contacts-page.ts` | modify | The query behind that filter |
| Smokes | create/modify | `smoke-import-provenance`, `smoke-finish-scene-geometry`, `smoke-import-finish`, `smoke-import-undo`, `smoke-import-history-render` (mod), `smoke-toast-copy` (passes) |

---

### Task 1: Merge main and record the baseline

The orbit scene this borrows from (`src/components/chat/chat-orbit.tsx`, `src/lib/chat-orbit-geometry.ts`, the `.chat-orbit-*` rules in `globals.css`) landed on main after this branch was cut, and main is ~11 commits ahead. Everything downstream reads post-merge files.

**Files:** whatever the merge touches.

**Interfaces:**
- Produces: a merged branch; the recorded eslint warning baseline; confirmation of `SCHEMA_VERSION` after the merge.

- [ ] **Step 1: Merge.**

```bash
git switch claude/imports-page-redesign-decdb0
git fetch origin
git merge origin/main
```

Resolve conflicts by keeping both sides' intent; `src/lib/imports/import-summary.ts`, `src/components/imports/*` and `src/db/schema.ts` are the likely spots. If main changed `SCHEMA_VERSION`, keep main's value.

- [ ] **Step 2: Gates.** Stop any dev server for this worktree first.

```bash
npx tsc --noEmit
npx eslint .
npm test
```

Record the eslint warning count in the commit message; that number is the baseline for every later task. All smokes must pass before continuing — a red suite here is main's problem to understand, not something to build on.

- [ ] **Step 3: Confirm the borrowed pieces exist.**

```bash
ls src/components/chat/chat-orbit.tsx src/lib/chat-orbit-geometry.ts
grep -n "chat-orbit" src/app/globals.css | head
```

If `chat-orbit-geometry.ts` is absent, stop and report: the scene's ring constants were expected there.

- [ ] **Step 4: Commit the merge** (message: `Merge origin/main into the imports redesign`, plus the baseline line and the Co-Authored-By trailer).

---

### Task 2: The fingerprint (pure)

**Files:**
- Create: `src/lib/imports/import-provenance.ts`
- Create: `scripts/smoke-import-provenance.ts` (register `"smoke-import-provenance": "pure"`)

**Interfaces:**
- Produces:
  - `type ImportedContactProvenance = { created: boolean; fp?: string }`
  - `type FingerprintInput = { fullName?: string | null; company?: string | null; title?: string | null; email?: string | null; linkedinUrl?: string | null }`
  - `fingerprintContact(input: FingerprintInput): string`
  - `PROVENANCE_KEY = "importedBy"` — the key under which a row's payload carries its provenance

- [ ] **Step 1: Write the failing test** `scripts/smoke-import-provenance.ts`:

```ts
/**
 * The fingerprint undo leans on: does this contact still hold exactly what the import wrote?
 *
 * Orbit has no per-contact edit trail, and `contacts.updated_at` is useless for the question —
 * the avatar backfill and the brief writer bump it minutes after every import. So the import
 * stamps a hash of the identifying fields it wrote, and undo compares.
 *
 * Run: npx tsx scripts/smoke-import-provenance.ts
 */
import { fingerprintContact } from "../src/lib/imports/import-provenance";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const base = {
  fullName: "Priya Raman",
  company: "Stripe",
  title: "Engineer",
  email: "priya@example.com",
  linkedinUrl: "https://www.linkedin.com/in/priya-raman",
};

check("same fields, same hash", fingerprintContact(base) === fingerprintContact({ ...base }));
check("a changed name changes it", fingerprintContact(base) !== fingerprintContact({ ...base, fullName: "Priya R" }));
check("a changed company changes it", fingerprintContact(base) !== fingerprintContact({ ...base, company: "Shopify" }));
check("a changed title changes it", fingerprintContact(base) !== fingerprintContact({ ...base, title: "Staff Engineer" }));
check("a changed email changes it", fingerprintContact(base) !== fingerprintContact({ ...base, email: "p@example.com" }));
check("a changed LinkedIn changes it", fingerprintContact(base) !== fingerprintContact({ ...base, linkedinUrl: "https://www.linkedin.com/in/other" }));

// Absent and empty mean the same thing: the import wrote nothing there.
check("null and undefined agree", fingerprintContact({ fullName: "A", company: null }) === fingerprintContact({ fullName: "A" }));
check("empty string counts as nothing", fingerprintContact({ fullName: "A", company: "" }) === fingerprintContact({ fullName: "A" }));
// Whitespace and case are not edits worth vetoing an undo over.
check("trimmed", fingerprintContact({ fullName: " A " }) === fingerprintContact({ fullName: "A" }));
check("case-insensitive", fingerprintContact({ fullName: "Priya" }) === fingerprintContact({ fullName: "priya" }));
// Field boundaries must not smear: "ab"+"" and "a"+"b" are different people.
check("fields don't smear", fingerprintContact({ fullName: "ab" }) !== fingerprintContact({ fullName: "a", company: "b" }));
check("a hash, not the data", !fingerprintContact(base).includes("Priya"));

if (failures) {
  console.error(`smoke-import-provenance: ${failures} failed`);
  process.exit(1);
}
console.log("smoke-import-provenance: all checks passed");
process.exit(0);
```

- [ ] **Step 2: Run it — expect FAIL** (module not found): `npx tsx scripts/smoke-import-provenance.ts`

- [ ] **Step 3: Implement** `src/lib/imports/import-provenance.ts`:

```ts
import { createHash } from "node:crypto";

/**
 * What an import remembers about a contact it wrote, so an undo can be exact rather than
 * inferred.
 *
 * `created` separates the people the import brought into existence from the ones it merged
 * into — only the former can be undone. `fp` is a fingerprint of the identifying fields it
 * wrote: if the contact still hashes the same, nobody has edited it since.
 *
 * Why a fingerprint at all: Orbit keeps no per-contact edit trail, and `contacts.updated_at`
 * cannot stand in for one — `avatar-backfill.ts` and `contact-brief.ts` write to imported
 * contacts minutes later and bump it, so it reads "touched" for nearly everyone.
 */
export type ImportedContactProvenance = { created: boolean; fp?: string };

export type FingerprintInput = {
  fullName?: string | null;
  company?: string | null;
  title?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
};

/** The payload key a staged row carries its provenance under. */
export const PROVENANCE_KEY = "importedBy";

/** Order is part of the hash: changing it invalidates every stored fingerprint. */
const FIELDS: (keyof FingerprintInput)[] = [
  "fullName",
  "company",
  "title",
  "email",
  "linkedinUrl",
];

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function fingerprintContact(input: FingerprintInput): string {
  // A separator no field can contain, so "ab" + "" can never collide with "a" + "b".
  const joined = FIELDS.map((f) => normalize(input[f])).join("\u0000");
  return createHash("sha256").update(joined).digest("hex").slice(0, 32);
}
```

- [ ] **Step 4: Run it — expect all `ok`.** Register in `MANIFEST`, then `npx tsx scripts/run-smoke.ts --check` → `structure ok`. `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/imports/import-provenance.ts scripts/smoke-import-provenance.ts scripts/run-smoke.ts
git commit -m "Remember what an import wrote, so an undo can be exact

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The engine stamps provenance

**Files:**
- Modify: `src/lib/import-engine.ts` (`markRowsDone`, and the two places that fill `contactIdByRowId`)
- Test: extend `scripts/smoke-import-engine.ts`

**Interfaces:**
- Consumes: `fingerprintContact`, `PROVENANCE_KEY`, `ImportedContactProvenance` (Task 2).
- Produces: every row the engine marks done carries `payload.importedBy = { created, fp? }`.

- [ ] **Step 1: Write the failing test.** In `scripts/smoke-import-engine.ts`, after an existing import scenario that both creates and merges people, add:

```ts
console.log("Rows remember whether they created or merged");
{
  const rows = await db.query.importJobRows.findMany({
    where: eq(importJobRows.importId, importId),
  });
  const done = rows.filter((r) => r.status === "done");
  check("every done row carries provenance", done.every((r) => (r.payload as Record<string, unknown>).importedBy !== undefined));
  const created = done.filter((r) => ((r.payload as { importedBy?: { created?: boolean } }).importedBy?.created) === true);
  const merged = done.filter((r) => ((r.payload as { importedBy?: { created?: boolean } }).importedBy?.created) === false);
  check("created rows are marked created", created.length > 0);
  check("merged rows are marked merged", merged.length > 0);
  check("created rows carry a fingerprint", created.every((r) => typeof (r.payload as { importedBy?: { fp?: string } }).importedBy?.fp === "string"));
  check("merged rows carry no fingerprint", merged.every((r) => (r.payload as { importedBy?: { fp?: string } }).importedBy?.fp === undefined));
}
```

Use the file's existing `check` helper, its `db`/`importId` bindings and its import list; add `importJobRows` to the schema imports if absent. If no existing scenario produces both a create and a merge, extend the nearest one by re-importing the same file so the second run merges.

- [ ] **Step 2: Run it — expect FAIL** (`importedBy` undefined): `npx tsx scripts/smoke-import-engine.ts`

- [ ] **Step 3: Implement.** In `src/lib/import-engine.ts`:

Change `markRowsDone`'s signature and statement so the payload is merged in the same UPDATE:

```ts
async function markRowsDone(
  rowIds: string[],
  contactIdByRowId: Map<string, string>,
  provenanceByRowId: Map<string, ImportedContactProvenance>
) {
  if (rowIds.length === 0) return;
  const db = await getDb();
  const now = new Date();
  const tuples = rowIds.map(
    (rowId) =>
      sql`(${rowId}::uuid, ${contactIdByRowId.get(rowId) ?? null}::uuid, ${JSON.stringify(
        provenanceByRowId.get(rowId) ?? { created: false }
      )}::jsonb)`
  );
  await db.execute(sql`
    UPDATE import_job_rows AS r
    SET status = 'done',
        contact_id = v.contact_id,
        -- Merged, not replaced: the payload is the adapter's row and must survive.
        payload = coalesce(r.payload, '{}'::jsonb) || jsonb_build_object('importedBy', v.provenance),
        updated_at = ${now}
    FROM (VALUES ${sql.join(tuples, sql`, `)}) AS v(id, contact_id, provenance)
    WHERE r.id = v.id
  `);
}
```

Build the map alongside `contactIdByRowId`. In the create branch (where `created.forEach((contact, i) => …)` sets `contactIdByRowId`), add:

```ts
provenanceByRowId.set(batch[i].row.id, {
  created: true,
  fp: fingerprintContact(batch[i].input),
});
```

In the merge branch (`for (const item of batch)` after `bulkMergeContactsForUser`), add:

```ts
provenanceByRowId.set(item.row.id, { created: false });
```

Declare `const provenanceByRowId = new Map<string, ImportedContactProvenance>();` next to `contactIdByRowId`, and pass it at the `markRowsDone(doneRowIds, contactIdByRowId)` call site. Import `fingerprintContact` and the type from `@/lib/imports/import-provenance`.

`batch[i].input` is a `ContactInput`; `fingerprintContact` only reads the five fields it names, so pass it directly. If `ContactInput`'s field names differ from `FingerprintInput`'s (check `fullName`, `company`, `title`, `email`, `linkedinUrl`), map them explicitly rather than widening the fingerprint's type.

- [ ] **Step 4: Run.** `npx tsx scripts/smoke-import-engine.ts` → all ok, including the pre-existing assertions. Then `npx tsx scripts/smoke-import-people.ts` and `npx tsx scripts/smoke-import-resumption-auth.ts` (both read these rows). `npx tsc --noEmit` clean; `npx eslint src/lib/import-engine.ts` 0 errors.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/import-engine.ts scripts/smoke-import-engine.ts
git commit -m "Record per row whether the import created or merged that person

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The undo rule (database)

**Files:**
- Create: `src/lib/imports/import-undo.ts`
- Create: `scripts/smoke-import-undo.ts` (register `"smoke-import-undo": "pglite"`, and give it `3 * 60_000` in the timeouts map next to `smoke-import-engine`)

**Interfaces:**
- Consumes: `PROVENANCE_KEY`, `fingerprintContact` (Task 2); `deleteContactForUser` from `@/lib/contact-delete`.
- Produces:
  - `UNDO_WINDOW_DAYS = 7`
  - `type UndoCandidate = { contactId: string; name: string; removable: boolean; reason?: "tagged" | "noted" | "reminded" | "interacted" | "merged" | "edited" }`
  - `type UndoPreview = { importId: string; withinWindow: boolean; exact: boolean; candidates: UndoCandidate[]; removable: number; keeping: number }`
  - `previewUndo(userId: string, importId: string, now?: Date): Promise<UndoPreview | null>`
  - `performUndo(userId: string, importId: string, now?: Date): Promise<{ removed: number; kept: number }>`

- [ ] **Step 1: Write the failing test** `scripts/smoke-import-undo.ts`:

```ts
/**
 * Undo removes the people an import created — and nobody else.
 *
 * The rule cannot lean on `contacts.updated_at`: system writes (the avatar backfill, the brief
 * writer) bump it minutes after every import. So a person is removable only when they carry no
 * user-authored trace AND still hash to what the import wrote.
 *
 * Run: npx tsx scripts/smoke-import-undo.ts
 */
import "./smoke/_env";

import { eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  contactTags,
  contacts,
  importJobRows,
  imports,
  interactions,
  reminders,
  tags,
} from "../src/db/schema";
import { ensureUserSettings } from "../src/lib/user-settings";
import { fingerprintContact } from "../src/lib/imports/import-provenance";
import { performUndo, previewUndo, UNDO_WINDOW_DAYS } from "../src/lib/imports/import-undo";

const USER = "smoke-import-undo-user";
const OTHER = "smoke-import-undo-other";
const NOW = new Date("2026-09-22T12:00:00Z");

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  await db.delete(reminders).where(inArray(reminders.userId, [USER, OTHER]));
  await db.delete(interactions).where(inArray(interactions.userId, [USER, OTHER]));
  await db.delete(contacts).where(inArray(contacts.userId, [USER, OTHER]));
  await db.delete(imports).where(inArray(imports.userId, [USER, OTHER]));
  await db.delete(tags).where(inArray(tags.userId, [USER, OTHER]));
}

/** One import with one staged row per person, stamped the way the engine stamps them. */
async function seedImport(
  userId: string,
  people: { name: string; created: boolean; company?: string | null }[],
  createdAt = NOW,
) {
  const db = await getDb();
  const [imp] = await db
    .insert(imports)
    .values({ userId, importType: "linkedin_connections", status: "completed", createdAt, totalRows: people.length })
    .returning();
  const ids: string[] = [];
  for (const [i, p] of people.entries()) {
    const [c] = await db
      .insert(contacts)
      .values({ userId, fullName: p.name, company: p.company ?? null, createdAt })
      .returning();
    ids.push(c.id);
    await db.insert(importJobRows).values({
      importId: imp.id,
      userId,
      rowIndex: i,
      status: "done",
      contactId: c.id,
      payload: {
        kind: "linkedin_connection",
        importedBy: p.created
          ? { created: true, fp: fingerprintContact({ fullName: p.name, company: p.company ?? null }) }
          : { created: false },
      } as never,
    });
  }
  return { importId: imp.id, ids };
}

async function main() {
  await reset();
  await ensureUserSettings(USER);
  const db = await getDb();

  const { importId, ids } = await seedImport(USER, [
    { name: "Untouched One", created: true },
    { name: "Untouched Two", created: true },
    { name: "Tagged Person", created: true },
    { name: "Noted Person", created: true },
    { name: "Reminded Person", created: true },
    { name: "Talked To", created: true },
    { name: "Edited Person", created: true, company: "Stripe" },
    { name: "Merged Person", created: false },
  ]);
  const [untouchedA, untouchedB, tagged, noted, reminded, talked, edited, merged] = ids;

  const [tag] = await db.insert(tags).values({ userId: USER, name: "friends" }).returning();
  await db.insert(contactTags).values({ contactId: tagged, tagId: tag.id });
  await db.update(contacts).set({ notes: "Met at a conference" }).where(eq(contacts.id, noted));
  await db.insert(reminders).values({ userId: USER, contactId: reminded, title: "Say hi" });
  await db.insert(interactions).values({ userId: USER, contactId: talked, interactionType: "call", occurredAt: NOW });
  await db.update(contacts).set({ company: "Shopify" }).where(eq(contacts.id, edited));

  const preview = await previewUndo(USER, importId, NOW);
  check("preview exists", Boolean(preview));
  check("in the window", preview!.withinWindow);
  check("exact, because rows carry fingerprints", preview!.exact);
  check("two are removable", preview!.removable === 2, String(preview!.removable));
  check("five are kept", preview!.keeping === 5, String(preview!.keeping));
  const reasonFor = (id: string) => preview!.candidates.find((c) => c.contactId === id)?.reason;
  check("tagged is kept for its tag", reasonFor(tagged) === "tagged");
  check("noted is kept for its note", reasonFor(noted) === "noted");
  check("reminded is kept for its reminder", reasonFor(reminded) === "reminded");
  check("talked-to is kept for its interaction", reasonFor(talked) === "interacted");
  check("edited is kept for its changed fields", reasonFor(edited) === "edited");
  check("merged is not a candidate at all", !preview!.candidates.some((c) => c.contactId === merged));

  const done = await performUndo(USER, importId, NOW);
  check("removed both untouched people", done.removed === 2, JSON.stringify(done));
  const left = await db.query.contacts.findMany({ where: eq(contacts.userId, USER) });
  const leftIds = new Set(left.map((c) => c.id));
  check("the untouched are gone", !leftIds.has(untouchedA) && !leftIds.has(untouchedB));
  for (const [label, id] of [["tagged", tagged], ["noted", noted], ["reminded", reminded], ["talked to", talked], ["edited", edited], ["merged", merged]] as const) {
    check(`${label} survived`, leftIds.has(id));
  }

  const again = await performUndo(USER, importId, NOW);
  check("a second undo removes nothing", again.removed === 0);
  const after = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
  check("the import records the undo", Boolean(after?.stats?.undoneAt));
  check("…and how many went", after?.stats?.undoneRemoved === 2, JSON.stringify(after?.stats));

  // Another user's import is invisible.
  const foreign = await seedImport(OTHER, [{ name: "Not Yours", created: true }]);
  check("another user gets no preview", (await previewUndo(USER, foreign.importId, NOW)) === null);
  check("…and no removal", (await performUndo(USER, foreign.importId, NOW)).removed === 0);
  const theirs = await db.query.contacts.findMany({ where: eq(contacts.userId, OTHER) });
  check("…their person is untouched", theirs.length === 1);

  // Outside the window.
  const old = await seedImport(USER, [{ name: "Old Import Person", created: true }], new Date("2026-09-01T12:00:00Z"));
  const oldPreview = await previewUndo(USER, old.importId, NOW);
  check(`older than ${UNDO_WINDOW_DAYS} days is out of the window`, oldPreview!.withinWindow === false);
  check("…and performing it removes nothing", (await performUndo(USER, old.importId, NOW)).removed === 0);

  // A pre-fingerprint import: rows with no provenance fall back to created-after-the-import.
  const legacy = await seedImport(USER, [{ name: "Legacy Person", created: true }]);
  await db
    .update(importJobRows)
    .set({ payload: { kind: "linkedin_connection" } as never })
    .where(eq(importJobRows.importId, legacy.importId));
  const legacyPreview = await previewUndo(USER, legacy.importId, NOW);
  check("legacy rows still produce a candidate", legacyPreview!.candidates.length === 1);
  check("…but the preview is not exact", legacyPreview!.exact === false);

  await reset();
  console.log("smoke-import-undo: all checks passed");
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await reset().catch(() => {});
  process.exit(1);
});
```

Before writing this, read `src/db/schema.ts` for the real required columns of `tags`, `contactTags`, `reminders` and `interactions` (for example `interactions` may require `externalId` or a different date column) and adjust the seed values — the assertions matter, the column names must match reality.

- [ ] **Step 2: Run — expect FAIL** (module not found): `npx tsx scripts/smoke-import-undo.ts`

- [ ] **Step 3: Implement** `src/lib/imports/import-undo.ts`:

```ts
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { contacts, imports } from "@/db/schema";
import { deleteContactForUser } from "@/lib/contact-delete";
import { fingerprintContact } from "@/lib/imports/import-provenance";

/**
 * Undoing an import.
 *
 * Only people the import CREATED can go, and only while nobody has touched them. "Touched" is
 * deliberately not `contacts.updated_at`: the avatar backfill and the brief writer bump that
 * column minutes after an import, so it reads "touched" for nearly every imported person, and
 * Orbit keeps no per-contact edit trail to consult instead. So the test is a user-authored
 * trace — a tag, a note, a reminder, an interaction, a later merge — plus the fingerprint the
 * import stamped on the row (`import-provenance.ts`).
 *
 * Rows staged before that stamp existed carry no provenance. They fall back to "created at or
 * after the import", the same rule the People list uses, and the preview reports itself as not
 * exact so the UI can say what it cannot vouch for.
 */
export const UNDO_WINDOW_DAYS = 7;

export type UndoCandidate = {
  contactId: string;
  name: string;
  removable: boolean;
  reason?: "tagged" | "noted" | "reminded" | "interacted" | "merged" | "edited";
};

export type UndoPreview = {
  importId: string;
  withinWindow: boolean;
  /** False when any candidate came from the fallback rule rather than a stamped row. */
  exact: boolean;
  candidates: UndoCandidate[];
  removable: number;
  keeping: number;
};

type CandidateRow = {
  contact_id: string;
  full_name: string;
  company: string | null;
  title: string | null;
  email: string | null;
  linkedin_url: string | null;
  notes: string | null;
  fp: string | null;
  stamped: boolean;
  tag_count: number;
  reminder_count: number;
  interaction_count: number;
  merge_count: number;
};

function withinWindow(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() <= UNDO_WINDOW_DAYS * 86_400_000;
}

/**
 * One statement for the whole decision: who this import created, and what has happened to them
 * since. The counts are correlated subqueries rather than joins so a person with three tags is
 * still one row.
 */
async function candidateRows(userId: string, importId: string, importCreatedAt: Date) {
  const db = await getDb();
  return rowsOf<CandidateRow>(
    await db.execute(sql`
      SELECT c.id AS contact_id, c.full_name, c.company, c.title, c.email, c.linkedin_url, c.notes,
             r.payload->'importedBy'->>'fp' AS fp,
             (r.payload ? 'importedBy') AS stamped,
             (SELECT count(*) FROM contact_tags ct WHERE ct.contact_id = c.id)::int AS tag_count,
             (SELECT count(*) FROM reminders rm WHERE rm.contact_id = c.id AND rm.user_id = ${userId})::int AS reminder_count,
             (SELECT count(*) FROM interactions i
                WHERE i.contact_id = c.id AND i.user_id = ${userId}
                  AND (i.external_id IS NULL OR i.created_at > ${importCreatedAt}))::int AS interaction_count,
             (SELECT count(*) FROM contact_merges m
                WHERE m.user_id = ${userId} AND m.winner_contact_id = c.id)::int AS merge_count
      FROM import_job_rows r
      JOIN contacts c ON c.id = r.contact_id AND c.user_id = ${userId}
      WHERE r.import_id = ${importId}
        AND r.user_id = ${userId}
        AND r.status = 'done'
        AND r.contact_id IS NOT NULL
        AND (
          (r.payload->'importedBy'->>'created') = 'true'
          OR (NOT (r.payload ? 'importedBy') AND c.created_at >= ${importCreatedAt})
        )
    `),
  );
}

function decide(row: CandidateRow): UndoCandidate {
  const base = { contactId: row.contact_id, name: row.full_name };
  if (row.tag_count > 0) return { ...base, removable: false, reason: "tagged" };
  if ((row.notes ?? "").trim()) return { ...base, removable: false, reason: "noted" };
  if (row.reminder_count > 0) return { ...base, removable: false, reason: "reminded" };
  if (row.interaction_count > 0) return { ...base, removable: false, reason: "interacted" };
  if (row.merge_count > 0) return { ...base, removable: false, reason: "merged" };
  if (row.fp) {
    const current = fingerprintContact({
      fullName: row.full_name,
      company: row.company,
      title: row.title,
      email: row.email,
      linkedinUrl: row.linkedin_url,
    });
    if (current !== row.fp) return { ...base, removable: false, reason: "edited" };
  }
  return { ...base, removable: true };
}

export async function previewUndo(
  userId: string,
  importId: string,
  now: Date = new Date(),
): Promise<UndoPreview | null> {
  const db = await getDb();
  const imp = await db.query.imports.findFirst({
    where: and(eq(imports.id, importId), eq(imports.userId, userId)),
    columns: { id: true, createdAt: true, stats: true },
  });
  if (!imp) return null;

  const rows = await candidateRows(userId, importId, imp.createdAt);
  const candidates = rows.map(decide);
  return {
    importId,
    withinWindow: withinWindow(imp.createdAt, now) && !imp.stats?.undoneAt,
    exact: rows.every((r) => r.stamped),
    candidates,
    removable: candidates.filter((c) => c.removable).length,
    keeping: candidates.filter((c) => !c.removable).length,
  };
}

export async function performUndo(
  userId: string,
  importId: string,
  now: Date = new Date(),
): Promise<{ removed: number; kept: number }> {
  const preview = await previewUndo(userId, importId, now);
  if (!preview || !preview.withinWindow) return { removed: 0, kept: preview?.keeping ?? 0 };

  let removed = 0;
  for (const candidate of preview.candidates) {
    if (!candidate.removable) continue;
    const { deleted } = await deleteContactForUser(userId, candidate.contactId);
    if (deleted) removed += 1;
  }

  const db = await getDb();
  await db
    .update(imports)
    .set({
      stats: sql`coalesce(${imports.stats}, '{}'::jsonb) || ${JSON.stringify({
        undoneAt: now.toISOString(),
        undoneRemoved: removed,
        undoneKept: preview.keeping,
      })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(imports.id, importId), eq(imports.userId, userId)));

  return { removed, kept: preview.keeping };
}
```

Add the three fields to `ImportStats` in `src/db/schema.ts` (types only, no DDL):

```ts
  /** Set when an import was undone: when, and what went. See `lib/imports/import-undo.ts`. */
  undoneAt?: string;
  undoneRemoved?: number;
  undoneKept?: number;
```

Two things to verify while implementing, and adjust the SQL to match: the real column names on `contact_merges` (the plan assumes `user_id` and `winner_contact_id` — `contact-delete.ts` reads `contactMerges.winnerContactId`), and whether `interactions` has `external_id` and `created_at`. The intent of the interaction subquery is "anything other than the interactions this import itself wrote"; if the columns differ, express that intent with the columns that exist and say so in the report.

- [ ] **Step 4: Run** `npx tsx scripts/smoke-import-undo.ts` → all ok. Register it in `MANIFEST` with tier `"pglite"` plus its timeout entry; `npx tsx scripts/run-smoke.ts --check`. `npx tsc --noEmit`; `npx eslint src/lib/imports/import-undo.ts` 0 errors.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/imports/import-undo.ts src/db/schema.ts scripts/smoke-import-undo.ts scripts/run-smoke.ts
git commit -m "Undo an import: remove the people it created, if nobody touched them

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The sentence and the button (pure)

**Files:**
- Create: `src/lib/imports/import-finish.ts`
- Create: `scripts/smoke-import-finish.ts` (register `"pure"`)

**Interfaces:**
- Produces:
  - `type FinishSummary = { importId: string; added: number; existing: number; meetingsLogged: number; sources: string[]; unfinished?: string }`
  - `type FinishCopy = { headline: string; detail: string | null; action: { label: string; href: string } | { label: string; kind: "detail" } }`
  - `finishCopy(summary: FinishSummary): FinishCopy`

- [ ] **Step 1: Write the failing test** `scripts/smoke-import-finish.ts`:

```ts
/**
 * What the done card says. The arithmetic has to agree with the history chips and the People
 * list — they disagreed once already (the engine counts a merged person under two counters),
 * and a third place to get it wrong is exactly how that comes back.
 *
 * Run: npx tsx scripts/smoke-import-finish.ts
 */
import { finishCopy, type FinishSummary } from "../src/lib/imports/import-finish";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const base: FinishSummary = {
  importId: "i1",
  added: 19,
  existing: 6,
  meetingsLogged: 0,
  sources: ["Connections.csv"],
};

const normal = finishCopy(base);
check("counts the new people", normal.headline.includes("19"));
check("names the ones already here", (normal.detail ?? "").includes("6"));
check("the button goes to this import's people", "href" in normal.action && normal.action.href === "/contacts?importId=i1");
check("the button names the number", normal.action.label.includes("19"));

const one = finishCopy({ ...base, added: 1, existing: 0 });
check("one person reads as a person", one.headline.includes("1 person") && !one.headline.includes("1 people"));
check("nobody already here means no second line", one.detail === null);

const nobodyNew = finishCopy({ ...base, added: 0, existing: 25 });
check("nobody new is not a lie", !nobodyNew.headline.includes("0 people"));
check("…and the button changes", "kind" in nobodyNew.action && nobodyNew.action.kind === "detail");

const calendar = finishCopy({ ...base, added: 0, existing: 0, meetingsLogged: 38, sources: ["work.ics"] });
check("a calendar import reports meetings", calendar.headline.includes("38"));
check("…and does not claim people", !calendar.headline.includes("0"));

const several = finishCopy({ ...base, sources: ["Connections.csv", "messages.csv"] });
check("several files are named", (several.detail ?? "").includes("Connections.csv") && (several.detail ?? "").includes("messages.csv"));

const partial = finishCopy({ ...base, unfinished: "LinkedIn messages didn’t finish" });
check("an unfinished step leads", partial.headline.includes("didn’t finish"));
check("…and still offers the people that landed", "href" in partial.action);

for (const copy of [normal, one, nobodyNew, calendar, several, partial]) {
  const lines = [copy.headline, copy.detail ?? "", copy.action.label];
  for (const line of lines) {
    check(`house voice: ${line.slice(0, 40)}`, !/\bfailed\b/i.test(line) && !line.endsWith(".") && !line.includes("'") && (line.match(/ — /g) ?? []).length <= 1, line);
  }
}

if (failures) {
  console.error(`smoke-import-finish: ${failures} failed`);
  process.exit(1);
}
console.log("smoke-import-finish: all checks passed");
process.exit(0);
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** `src/lib/imports/import-finish.ts`:

```ts
/**
 * The done card's words.
 *
 * Pure, and the single source of the finish's arithmetic: the card, the history chips and the
 * People list all describe the same import, and they have disagreed before — the engine counts
 * every merged person under both `contactsUpdated` and `duplicatesFound`, which once rendered
 * as "2 updated · 2 already here" for two people. The counts arrive here already reconciled;
 * this module only chooses the words.
 */
export type FinishSummary = {
  importId: string;
  /** People the import brought into Orbit. */
  added: number;
  /** People it matched to someone already here. */
  existing: number;
  meetingsLogged: number;
  /** File names or connection labels, in the order they ran. */
  sources: string[];
  /** Set when a step didn't finish — the card leads with this instead of celebrating. */
  unfinished?: string;
};

export type FinishCopy = {
  headline: string;
  detail: string | null;
  action: { label: string; href: string } | { label: string; kind: "detail" };
};

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

export function finishCopy(summary: FinishSummary): FinishCopy {
  const { added, existing, meetingsLogged, sources, importId, unfinished } = summary;

  const headline = unfinished
    ? unfinished
    : added > 0
      ? `You added ${people(added)}`
      : meetingsLogged > 0
        ? `${meetingsLogged} meeting${meetingsLogged === 1 ? "" : "s"} logged`
        : existing > 0
          ? "Everyone here already"
          : "Nothing new this time";

  const parts: string[] = [];
  if (existing > 0 && added > 0) parts.push(`${people(existing)} were already in your orbit`);
  else if (existing > 0) parts.push(`${people(existing)} matched someone you already had`);
  if (sources.length > 1) parts.push(`From ${sources.join(" and ")}`);
  const detail = parts.length ? parts.join(" — ") : null;

  const action =
    added > 0
      ? { label: `Meet your ${people(added)}`, href: `/contacts?importId=${importId}` }
      : { label: "See what changed", kind: "detail" as const };

  return { headline, detail, action };
}
```

- [ ] **Step 4: Run** → all ok (if a case fails, fix the module, never the assertion). Register; `--check`; `npx tsx scripts/smoke-toast-copy.ts`; tsc.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/imports/import-finish.ts scripts/smoke-import-finish.ts scripts/run-smoke.ts
git commit -m "Say what an import actually did, in one sentence

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The swarm's geometry (pure)

**Files:**
- Create: `src/lib/imports/finish-scene-geometry.ts`
- Create: `scripts/smoke-finish-scene-geometry.ts` (register `"pure"`)

**Interfaces:**
- Produces:
  - `MAX_DOTS = 300`, `MAX_FACES = 12`, `SCENE_HEIGHT = { desktop: 180, phone: 120 }`
  - `type Dot = { ring: number; angle: number; radiusX: number; radiusY: number; delay: number; face: boolean }`
  - `dotCount(people: number): number`
  - `layoutDots(people: number, width: number, height: number): Dot[]`
  - `settle(t: number): number` — eased 0→1 over the arrival

- [ ] **Step 1: Write the failing test** `scripts/smoke-finish-scene-geometry.ts`:

```ts
/**
 * The swarm's maths, with no canvas in sight: how many dots a crowd becomes, where they sit,
 * and how they settle. 3,000 people must not mean 3,000 particles.
 *
 * Run: npx tsx scripts/smoke-finish-scene-geometry.ts
 */
import {
  MAX_DOTS,
  MAX_FACES,
  dotCount,
  layoutDots,
  settle,
} from "../src/lib/imports/finish-scene-geometry";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

check("a small import is one dot each", dotCount(12) === 12);
check("an empty import draws nothing", dotCount(0) === 0);
check("a huge import is capped", dotCount(3000) === MAX_DOTS);
check("…and the cap is the cap", dotCount(MAX_DOTS + 1) === MAX_DOTS);

const dots = layoutDots(3000, 600, 180);
check("lays out exactly the capped count", dots.length === MAX_DOTS);
check("no more faces than the cap", dots.filter((d) => d.face).length <= MAX_FACES);
check("faces are the ones that arrive first", dots.filter((d) => d.face).every((d) => d.delay <= Math.max(...dots.map((x) => x.delay)) / 2));
check("every dot sits inside the canvas", dots.every((d) => d.radiusX > 0 && d.radiusX <= 300 && d.radiusY > 0 && d.radiusY <= 90));
check("rings are used, not one circle", new Set(dots.map((d) => d.ring)).size > 1);
check("angles stay in one turn", dots.every((d) => d.angle >= 0 && d.angle < Math.PI * 2));
check("delays are staggered", new Set(dots.map((d) => d.delay)).size > 1);

const small = layoutDots(3, 600, 180);
check("three people are three dots", small.length === 3);
check("…and all three get faces", small.every((d) => d.face));

check("settle starts at the start", settle(0) === 0);
check("settle ends at the end", settle(1) === 1);
check("settle is monotonic", [0.1, 0.3, 0.5, 0.7, 0.9].every((t, i, a) => i === 0 || settle(t) > settle(a[i - 1])));
check("settle eases out, not linear", settle(0.5) > 0.5);

const phone = layoutDots(3000, 340, 120);
check("a phone canvas keeps dots inside it", phone.every((d) => d.radiusX <= 170 && d.radiusY <= 60));

if (failures) {
  console.error(`smoke-finish-scene-geometry: ${failures} failed`);
  process.exit(1);
}
console.log("smoke-finish-scene-geometry: all checks passed");
process.exit(0);
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement** `src/lib/imports/finish-scene-geometry.ts`:

```ts
/**
 * Where the swarm's dots go, with no canvas involved.
 *
 * Bounded on purpose: an import of 3,000 people draws 300 dots and lets the sentence carry the
 * number. The cost of the scene is the same for a huge import as for a middling one, which is
 * what makes it safe to run on a phone.
 */
export const MAX_DOTS = 300;
export const MAX_FACES = 12;
export const SCENE_HEIGHT = { desktop: 180, phone: 120 } as const;

/** Ring radii as a fraction of the canvas half-width / half-height. */
const RINGS = [
  { rx: 0.34, ry: 0.34, share: 0.3 },
  { rx: 0.62, ry: 0.58, share: 0.35 },
  { rx: 0.92, ry: 0.86, share: 0.35 },
] as const;

export type Dot = {
  ring: number;
  angle: number;
  radiusX: number;
  radiusY: number;
  /** Seconds before this dot starts arriving. */
  delay: number;
  face: boolean;
};

export function dotCount(people: number): number {
  return Math.max(0, Math.min(Math.floor(people), MAX_DOTS));
}

export function layoutDots(people: number, width: number, height: number): Dot[] {
  const count = dotCount(people);
  const halfW = width / 2;
  const halfH = height / 2;
  const dots: Dot[] = [];

  // The golden angle keeps successive dots from landing on top of each other without random.
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));

  for (let i = 0; i < count; i++) {
    const fraction = count === 1 ? 0 : i / count;
    let ring = RINGS.length - 1;
    let acc = 0;
    for (let r = 0; r < RINGS.length; r++) {
      acc += RINGS[r].share;
      if (fraction < acc) {
        ring = r;
        break;
      }
    }
    dots.push({
      ring,
      angle: (i * GOLDEN) % (Math.PI * 2),
      radiusX: halfW * RINGS[ring].rx,
      radiusY: halfH * RINGS[ring].ry,
      // Faces arrive first so the recognisable part of the scene lands early.
      delay: (i / Math.max(1, count)) * 1.2,
      face: i < Math.min(MAX_FACES, count),
    });
  }
  return dots;
}

/** Ease-out cubic: fast arrival, gentle landing. */
export function settle(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - clamped, 3);
}
```

- [ ] **Step 4: Run** → all ok. Register; `--check`; tsc; eslint.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/imports/finish-scene-geometry.ts scripts/smoke-finish-scene-geometry.ts scripts/run-smoke.ts
git commit -m "Work out where the swarm's dots belong

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Server actions and the contacts filter

**Files:**
- Modify: `src/actions/imports.ts`
- Modify: `src/lib/contacts-page.ts`
- Modify: `src/app/(clerk)/(app)/(main)/contacts/page.tsx`
- Modify: `src/app/(clerk)/(app)/(main)/imports/page.tsx`
- Test: extend `scripts/smoke-import-undo.ts` (the lib seam) and, if `src/lib/contacts-page.ts` has a smoke, extend it; otherwise add the filter case to `scripts/smoke-import-people.ts`

**Interfaces:**
- Consumes: `previewUndo`, `performUndo`, `UndoPreview` (Task 4); `countImportPeople`, `listImportPeople` (existing); `finishCopy`, `FinishSummary` (Task 5).
- Produces (all async, in `src/actions/imports.ts`):
  - `getLatestFinishedImport(): Promise<(FinishSummary & { undoneAt: string | null; avatars: { contactId: string; name: string; photo: string | null }[] }) | null>` — `undoneAt` is what Task 9 checks before rendering the card
  - `previewImportUndo(importId: string): Promise<UndoPreview | null>`
  - `undoImport(importId: string): Promise<{ removed: number; kept: number }>`
- Produces (in `src/lib/contacts-page.ts`): the existing list query accepts `importId?: string` and filters to that import's people.

- [ ] **Step 1: Write the failing test.** Append to `scripts/smoke-import-undo.ts`, before its final `reset()`:

```ts
  // The contacts list can be narrowed to one import's people.
  const { importId: filterImport, ids: filterIds } = await seedImport(USER, [
    { name: "Filter One", created: true },
    { name: "Filter Two", created: true },
  ]);
  await db.insert(contacts).values({ userId: USER, fullName: "Not From An Import" });
  const listed = await listContactsPage(USER, { importId: filterImport });
  check("the filter returns only that import's people", listed.contacts.length === 2, String(listed.contacts.length));
  check("…and they are the right two", listed.contacts.every((c) => filterIds.includes(c.id)));
  const unfiltered = await listContactsPage(USER, {});
  check("without the filter everyone is listed", unfiltered.contacts.length > 2);
```

Import the real list function from `../src/lib/contacts-page` and match its actual name and options shape — read the file first; the assertions are what matter.

- [ ] **Step 2: Run — expect FAIL** (unknown option / wrong count).

- [ ] **Step 3: Implement.**

In `src/lib/contacts-page.ts`, add `importId?: string` to the options type and, when present, constrain the query with the same union the People list uses:

```ts
    // Narrowed to one import's people: the rows that import wrote, plus any extra contacts a
    // single row touched (a Drive doc can name several people).
    importId
      ? sql`c.id IN (
          SELECT r.contact_id FROM import_job_rows r
          WHERE r.import_id = ${importId} AND r.user_id = ${userId}
            AND r.status = 'done' AND r.contact_id IS NOT NULL
          UNION
          SELECT (jsonb_array_elements_text(r.payload->'contactIds'))::uuid
          FROM import_job_rows r
          WHERE r.import_id = ${importId} AND r.user_id = ${userId}
            AND r.status = 'done' AND jsonb_typeof(r.payload->'contactIds') = 'array'
        )`
      : undefined,
```

Follow the file's own composition style (a `where` array, `and(...)`, or a query builder) rather than pasting this shape blindly.

In `src/app/(clerk)/(app)/(main)/contacts/page.tsx`, add `importId?: string` to the `searchParams` type and pass `params.importId` through to the list call. When it is set, render a small banner above the list — "From one import — show everyone" linking to `/contacts` — so the filter is never invisible.

In `src/actions/imports.ts` add the three async actions. `getLatestFinishedImport` reads the newest `completed` import for the user, builds a `FinishSummary` from the same fields `summarizeImport` uses (added = `contactsCreated`, existing = `contactsUpdated`, meetings = `stats.interactionsLogged`), and fetches up to `MAX_FACES` people with photos for the scene:

```ts
export async function getLatestFinishedImport() {
  const userId = await requireUserId();
  const db = await getDb();
  const row = await db.query.imports.findFirst({
    where: and(eq(imports.userId, userId), eq(imports.status, "completed")),
    orderBy: [desc(imports.createdAt)],
  });
  if (!row) return null;
  const people = await listImportPeople(userId, row.id, "added", 0);
  return {
    importId: row.id,
    added: row.contactsCreated ?? 0,
    existing: row.contactsUpdated ?? 0,
    meetingsLogged: row.stats?.interactionsLogged ?? 0,
    sources: row.fileName ? [row.fileName] : [importSourceLabel(row.importType)],
    undoneAt: row.stats?.undoneAt ?? null,
    avatars: people.people.slice(0, 12).map((p) => ({ contactId: p.id, name: p.name, photo: null })),
  };
}
```

`ImportedPerson` carries no photo today. Either extend `listImportPeople`'s projection with `profileImageUrl` (preferred — one column, and the People list can show faces later too) or select the photos separately; do not invent a field name that doesn't exist. Keep `MAX_FACES` imported from the geometry module rather than hard-coding 12 twice.

`previewImportUndo` and `undoImport` are thin: `requireUserId()`, then the lib function, then `revalidatePath("/imports")` after a successful undo.

**Do not add any non-async export to `src/actions/imports.ts`.** After editing: `grep -nE "^export (const|let|var|class|type \{) " src/actions/imports.ts` must print nothing.

In `src/app/(clerk)/(app)/(main)/imports/page.tsx`, call `getLatestFinishedImport()` alongside the existing awaits and pass the result to `ImportHub` as `latestFinish`.

- [ ] **Step 4: Run** the extended smoke, `npx tsx scripts/smoke-import-people.ts`, `npx tsc --noEmit`, `npx eslint .` (0 errors), and the export grep. Then load `/imports` and `/contacts?importId=<a real id>` in the dev server to prove the actions resolve — a `"use server"` export mistake only shows up when the route loads.

- [ ] **Step 5: Commit.**

```bash
git add src/actions/imports.ts src/lib/contacts-page.ts "src/app/(clerk)/(app)/(main)/contacts/page.tsx" "src/app/(clerk)/(app)/(main)/imports/page.tsx" scripts/smoke-import-undo.ts
git commit -m "Serve the finish, and let the contacts list show one import's people

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: The canvas

**Files:**
- Create: `src/components/imports/import-finish-scene.tsx`

**Interfaces:**
- Consumes: `layoutDots`, `dotCount`, `settle`, `MAX_FACES`, `SCENE_HEIGHT` (Task 6).
- Produces: `<ImportFinishScene people={number} faces={{ contactId, name, photo }[]} />`

- [ ] **Step 1: Implement** `src/components/imports/import-finish-scene.tsx`:

```tsx
"use client";

import { useEffect, useRef } from "react";
import { layoutDots, settle, SCENE_HEIGHT } from "@/lib/imports/finish-scene-geometry";

/**
 * The people an import brought in, arriving.
 *
 * A canvas rather than elements: an import can be thousands of people, and thousands of DOM
 * nodes with their own transforms is a different kind of page. The geometry lives next door in
 * a pure module so the maths is testable without a browser; this file owns pixels and lifetime.
 *
 * It stops when nobody is looking — off-screen or a hidden tab — because a drifting loop in a
 * background tab is a battery bug, and it never starts at all under reduced motion: that case
 * paints the settled frame once. The preference is read with `matchMedia` at effect time rather
 * than through a hook that reports the wrong value on its first render.
 */
export function ImportFinishScene({
  people,
  faces,
}: {
  people: number;
  faces: { contactId: string; name: string; photo: string | null }[];
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const phone = window.innerWidth < 640;
    const height = phone ? SCENE_HEIGHT.phone : SCENE_HEIGHT.desktop;
    const width = canvas.clientWidth || 600;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const dots = layoutDots(people, width, height);
    const images = new Map<number, HTMLImageElement>();
    dots.forEach((dot, i) => {
      const face = dot.face ? faces[i] : undefined;
      if (!face?.photo) return;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = face.photo;
      img.onload = () => images.set(i, img);
    });

    const cx = width / 2;
    const cy = height / 2;
    const styles = getComputedStyle(canvas);
    const teal = styles.getPropertyValue("--primary").trim() || "#0f766e";
    const gold = styles.getPropertyValue("--accent").trim() || "#d4a72c";

    function paint(elapsed: number, drift: number) {
      ctx.clearRect(0, 0, width, height);

      // The planet, and its tilted ring.
      ctx.beginPath();
      ctx.fillStyle = teal;
      ctx.arc(cx, cy, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-0.31);
      ctx.beginPath();
      ctx.strokeStyle = gold;
      ctx.globalAlpha = 0.7;
      ctx.ellipse(0, 0, 26, 7, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      dots.forEach((dot, i) => {
        const t = settle(Math.max(0, elapsed - dot.delay) / 1.4);
        if (t <= 0) return;
        const angle = dot.angle + drift * (dot.ring % 2 === 0 ? 1 : -1);
        // Arrive from outside: the radius eases in from 1.8x to its own.
        const rx = dot.radiusX * (1.8 - 0.8 * t);
        const ry = dot.radiusY * (1.8 - 0.8 * t);
        const x = cx + Math.cos(angle) * rx;
        const y = cy + Math.sin(angle) * ry;
        const img = images.get(i);
        ctx.globalAlpha = Math.min(1, t);
        if (img) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(x, y, 11, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(img, x - 11, y - 11, 22, 22);
          ctx.restore();
          ctx.beginPath();
          ctx.strokeStyle = gold;
          ctx.arc(x, y, 11, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.fillStyle = dot.face ? gold : teal;
          ctx.arc(x, y, dot.face ? 3.5 : 2, 0, Math.PI * 2);
          ctx.fill();
        }
      });
      ctx.globalAlpha = 1;
    }

    if (reduced) {
      paint(99, 0);
      return;
    }

    let raf = 0;
    let running = true;
    const start = performance.now();
    const loop = (now: number) => {
      if (!running) return;
      const elapsed = (now - start) / 1000;
      // Arrival for the first ~2s, then a slow drift so the card is alive but not busy.
      paint(elapsed, elapsed < 2 ? elapsed * 0.08 : 0.16 + (elapsed - 2) * 0.015);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };
    const resume = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(loop);
    };
    const onVisibility = () => (document.hidden ? stop() : resume());
    document.addEventListener("visibilitychange", onVisibility);
    const observer = new IntersectionObserver(
      ([entry]) => (entry.isIntersecting ? resume() : stop()),
      { threshold: 0 },
    );
    observer.observe(canvas);

    return () => {
      stop();
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [people, faces]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="block w-full"
      style={{ height: SCENE_HEIGHT.desktop }}
    />
  );
}
```

Two things to check against the repo while implementing: whether `--primary`/`--accent` in `globals.css` are colour values a canvas can use directly (if they are channel triplets or `oklch(...)` fragments, read the computed colour from a probe element instead, the way other canvas work in this repo does), and how existing canvas components size themselves on resize (add a `ResizeObserver` only if the card's width actually changes without a remount).

- [ ] **Step 2: Verify in the browser.** Start the dev server, drop a small CSV on `/imports` (the dev demo workspace accepts one), and confirm: the dots arrive and settle, no console errors, and the loop stops when you scroll the card out of view (check with a `console.count` in `paint` temporarily, then remove it). Then set the OS reduced-motion preference (or emulate it) and confirm a single painted frame and no loop.

- [ ] **Step 3: Commit.**

```bash
git add src/components/imports/import-finish-scene.tsx
git commit -m "Draw the people an import brought in, arriving

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: The done card and undo in history

**Files:**
- Create: `src/components/imports/import-finish-card.tsx`
- Modify: `src/components/imports/import-queue-card.tsx`
- Modify: `src/components/imports/import-hub.tsx`
- Modify: `src/components/imports/import-history.tsx`
- Modify: `src/lib/imports/import-copy.ts`
- Test: extend `scripts/smoke-import-history-render.ts`

**Interfaces:**
- Consumes: `finishCopy`, `FinishSummary` (Task 5); `ImportFinishScene` (Task 8); `getLatestFinishedImport`, `previewImportUndo`, `undoImport` (Task 7).
- Produces: `<ImportFinishCard summary={…} avatars={…} onDismiss={() => void} />`

- [ ] **Step 1: Write the failing test.** In `scripts/smoke-import-history-render.ts`, add:

```ts
console.log("An undone import says so");
const undone = render([
  item({ contactsCreated: 19, contactsUpdated: 6, duplicatesFound: 6, stats: { undoneAt: "2026-09-22T12:00:00Z", undoneRemoved: 17, undoneKept: 2 } }),
]);
check("the row says it was undone", undone.includes("Undone"));
check("…and how many went", undone.includes("17"));
check("…and never with the word “failed”", !/\bfailed\b/i.test(undone));
```

- [ ] **Step 2: Run — expect FAIL:** `npx tsx scripts/smoke-import-history-render.ts`

- [ ] **Step 3: Implement.**

`src/components/imports/import-finish-card.tsx` — a client component rendering, in order: `<ImportFinishScene people={summary.added || summary.existing} faces={avatars} />`, the headline in the display face (`font-[family-name:var(--font-display)] text-xl text-ink`), the detail line in muted text, the action (a `<Link>` for the href shape, a button opening the history sheet for the `detail` shape), and a final muted line carrying the source and an "Undo" button. The whole card reuses the queue card's own container classes (`rounded-2xl border border-border/70 bg-card p-6`) so the finish sits exactly where the queue card sat. The headline is wrapped in a `<p role="status">` so it is announced once when it appears.

Undo flow, shared by this card and the history sheet: click → `previewImportUndo(importId)` → a confirmation dialog (use the repo's existing dialog primitive; find one with `grep -rn "AlertDialog\|ConfirmDialog" src/components | head`) whose body is built from the preview:

```ts
const title = `Remove ${preview.removable} ${preview.removable === 1 ? "person" : "people"}?`;
const keeping = preview.keeping > 0
  ? `${preview.keeping} of them have notes or tags now, so they’ll stay`
  : null;
const caveat = preview.exact
  ? null
  : "This import ran before Orbit started tracking edits, so it can’t tell which of these you’ve changed";
```

Confirm → `undoImport(importId)` → toast `"Removed ${removed} ${removed === 1 ? "person" : "people"}"` → `router.refresh()`. Failure → `toast.error(friendlyError(err, IMPORT_COPY.undoFailed))` where `IMPORT_COPY.undoFailed = "Couldn’t undo that import — try again in a moment"`.

`import-queue-card.tsx`: when `queue.phase === "done"`, render `<ImportFinishCard>` with the summary built from the finished steps instead of today's heading + row list. Keep the existing dismiss X (it calls `clearImportQueue`) and keep the per-step error line for any step that didn't finish.

`import-hub.tsx`: accept `latestFinish` and render `<ImportFinishCard>` when the client queue is empty, the prop is present, its `undoneAt` is null, and its import id is not in the dismissed list. Dismissal is `localStorage` (`orbit.imports.finishDismissed`), read and written inside `try/catch`, treating absent as not dismissed.

`import-history.tsx`: in the detail sheet, show an "Undo this import" button when the import is within 7 days, created contacts, and has no `stats.undoneAt`; past that, a muted line "The 7-day window for undoing this import has closed". On the row, when `stats.undoneAt` is set, render "Undone · 17 people removed" in muted text and suppress the count chips.

- [ ] **Step 4: Run the gates.** `npx tsx scripts/smoke-import-history-render.ts`, `npx tsx scripts/smoke-toast-copy.ts`, `npx tsc --noEmit`, `npx eslint .` (0 errors, baseline warnings), then the full `npm test` with no dev server running.

- [ ] **Step 5: Verify live.** Dev server, `/imports`: run a small import, confirm the done card appears with the scene, the sentence matches the history chips for the same import, the button lands on `/contacts?importId=…` showing exactly those people, undo previews the right counts, removes them, and the history row then reads "Undone". Refresh mid-way to confirm the card survives, and dismiss to confirm it stays dismissed. Check 375px width. Screenshot the card for the report.

- [ ] **Step 6: Commit.**

```bash
git add src/components/imports/import-finish-card.tsx src/components/imports/import-queue-card.tsx src/components/imports/import-hub.tsx src/components/imports/import-history.tsx src/lib/imports/import-copy.ts scripts/smoke-import-history-render.ts
git commit -m "End an import with the people it brought in, and a way back

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## After the last task

- [ ] **Carry it to the Drive branch.** PR #247 (`claude/google-drive-import`) is stacked on this one and touches the same summary and history files:

```bash
git switch claude/google-drive-import
git merge claude/imports-page-redesign-decdb0
```

Resolve conflicts in `src/lib/imports/import-summary.ts` and `src/components/imports/import-history.tsx` by keeping both sides (Drive's chips and flags alongside the finish), run `npx tsc --noEmit` and `npx tsx scripts/smoke-import-history-render.ts`, commit the merge, and push both branches. Drive imports get the done card for free, since they land through the same runner.
