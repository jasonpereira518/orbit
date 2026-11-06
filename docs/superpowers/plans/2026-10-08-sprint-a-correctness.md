# Sprint A Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 16 Sprint A defects from the Oct 8 audit: follow-up drift, two silent data overwrites, the coming-soon action gate, outreach re-sends, the import drop race, two settings footguns, two capture losses, chat mid-stream races, and two layout bugs.

**Architecture:** Each fix lands in the shared function every caller routes through, with a smoke check that fails before the fix and passes after. Where component logic cannot be tested (no jsdom), the decision is extracted into a small pure function in `src/lib/` and tested there, or the source is checked for the guard the way `smoke-action-user-scope.ts` already does.

**Tech Stack:** Next.js 16 App Router, React 19 Server Actions, Drizzle ORM on PGlite (smokes) / Neon (prod), Tailwind v4, `tsx` smoke scripts.

**Spec:** `docs/superpowers/specs/2026-10-08-sprint-a-correctness-design.md`

## Global Constraints

- Branch: `claude/app-e2e-testing-audit-388719` in worktree `/Users/jasonpereira/Projects/claude-worktrees/orbit/job-change-alerts-radar-410b6a`. Base `main` @ `ea6ea73a`.
- Worktree needs `node_modules` from its own lockfile: if `ls node_modules/@sentry` fails, run `npm ci --ignore-scripts` first.
- Every smoke script is `scripts/smoke-<name>.ts`, registered in `MANIFEST` in `scripts/run-smoke.ts` as `"pure"` or `"pglite"`. A `pglite` script's first line is `import "./smoke/_env";`. A `pure` script never imports `../src/db`.
- `scripts/smoke-provider-exhaustive.ts` allowlists `src/actions/settings.ts:121`, `:123`, `:125`, `:277`, `:279`, `:281` and `src/components/settings/ai-settings.tsx:289` by line number. Do not shift those lines except where Tasks 9–10 update the allowlist. Re-run that smoke after every edit to those two files.
- Never write a Tailwind class name inside a code comment (the scanner compiles it).
- User-visible failures from a Server Action: `throw new UserFacingError(...)` or return `{ ok: false, error }`. Never surface `err.message`.
- Copy: no trailing period, curly apostrophe `’`, at most one ` — ` per string.
- No schema change, no `SCHEMA_VERSION` bump.
- Do not run `npm run build` or a second `next dev` in this worktree while a dev server is running on it.
- Line numbers below are from `ea6ea73a`. Earlier tasks shift later lines in the same file: locate by the quoted code, not the number.
- Commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A hand-written reminder that shares the follow-up's exact instant** (the demo's "Send Sarah the retrieval write-up") must stay listed in the bell and dashboard. Pinned in Task 2, step 1.
2. **Undo after a newer booking**: undoing a completion or a clear must not overwrite a follow-up booked in between. Pinned in Task 1 (Taylor Brooks) and Task 3 (second Undo).
3. **A drop while the queue is in review** must still replace it (it is the only way out of review). Pinned in Task 8.
4. **Social links saved before this change** (handles, non-web schemes) must render as nothing, not as broken links. Pinned in Task 10.
5. **A Stop that lands after the answer was persisted** must not delete the answer. Pinned by the call-order check in Task 13 plus `discardUnansweredQuestion`'s last-message rule, which Task 13 step 6 confirms before editing.

---

### Task 0: Commit the audit, spec and plan

**Files:**
- Modify: `docs/audits/2026-10-08-app-e2e-audit.md`

- [ ] **Step 1: Prune security detail (repo is public)**

In `docs/audits/2026-10-08-app-e2e-audit.md`:
- In the bullet starting `- **I7 [P1]**`, replace `relative URLs break, a script-scheme value is stored and rendered (self-XSS)` with `values are stored as typed`.
- Delete the whole bullet starting `- **I9 [P1]**`.
- In §7 under "Both:" replace `a connected-assistants list with revoke for MCP` with `a connected-assistants list for MCP`.
- In the final "Environment notes" paragraph delete the sentence starting `This file names a self-XSS`.

- [ ] **Step 2: Commit**

```bash
git add docs/audits/2026-10-08-app-e2e-audit.md docs/superpowers/specs/2026-10-08-sprint-a-correctness-design.md docs/superpowers/plans/2026-10-08-sprint-a-correctness.md
git commit -m "docs: Oct 8 app audit, Sprint A spec and plan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: Completing a contact's follow-up reminder clears their follow-up clock (R1)

**Files:**
- Modify: `src/lib/reminders.ts:1` (import), `:1480-1523` (`CompletionSnapshot`, `completeReminder`), before the final return of `reopenReminder` (~1559)
- Modify: `src/actions/reminders.ts:104-113` (`validCompletionSnapshot`), `:756-771` (`markReminderDone`, `reopenReminderAction`)
- Test: `scripts/smoke-toast-undo.ts` (pglite, already registered)

**Interfaces:**
- Produces: `CompletionSnapshot.clearedFollowUp?: { contactId: string; previousNextFollowUpAt: string; previousFollowUpStatus: string | null }`. Task 3 relies on `validCompletionSnapshot` accepting it.

- [ ] **Step 1: Write the failing checks**

In `scripts/smoke-toast-undo.ts`, inside the `/* complete → reopen */` block, change `const { contact, reminder } = await seedReminder("Priya Nair");` to:
```ts
    const { contact, reminder, originalDue } = await seedReminder("Priya Nair");
```
Directly after the check `"completing no longer re-stamps an item finished earlier"` add:
```ts
    const clearedNow = await db.query.contacts.findFirst({ where: eq(contacts.id, contact.id) });
    check("completing the contact's follow-up reminder clears their follow-up clock",
      clearedNow?.nextFollowUpAt === null && clearedNow?.followUpStatus === "none",
      `${clearedNow?.nextFollowUpAt?.toISOString()} ${clearedNow?.followUpStatus}`);
    check("…and the snapshot remembers what it cleared",
      snap?.clearedFollowUp?.contactId === contact.id &&
        snap.clearedFollowUp.previousNextFollowUpAt === originalDue.toISOString(),
      JSON.stringify(snap?.clearedFollowUp));
```
Directly after `check("…with its original completedAt", ...)` add:
```ts
    const clockBack = await db.query.contacts.findFirst({ where: eq(contacts.id, contact.id) });
    check("reopen puts the follow-up clock back exactly",
      ms(clockBack?.nextFollowUpAt) === ms(originalDue) && clockBack?.followUpStatus === "pending");
```
Before the line `/* ------------------------------------------------ dismiss suggestion → restore */` add:
```ts
  /* ------------------------- a reminder at another instant is not the follow-up */
  {
    const { contact, reminder, originalDue } = await seedReminder("Alex Moreno");
    await db.update(reminders).set({ dueDate: new Date(originalDue.getTime() + 86_400_000) })
      .where(eq(reminders.id, reminder.id));
    const snap = await completeReminder(USER, reminder.id);
    const c = await db.query.contacts.findFirst({ where: eq(contacts.id, contact.id) });
    check("a reminder due at a different instant leaves the clock alone",
      ms(c?.nextFollowUpAt) === ms(originalDue) && snap?.clearedFollowUp === undefined);
  }

  /* --------------------- Undo of a completion never clobbers a newer booking */
  {
    const { contact, reminder } = await seedReminder("Taylor Brooks");
    const snap = await completeReminder(USER, reminder.id);
    await scheduleContactFollowUp(contact.id, 3);
    const rebooked = await db.query.contacts.findFirst({ where: eq(contacts.id, contact.id) });
    await reopenReminder(USER, snap!);
    const c = await db.query.contacts.findFirst({ where: eq(contacts.id, contact.id) });
    check("a follow-up booked after the completion survives its Undo",
      ms(c?.nextFollowUpAt) === ms(rebooked?.nextFollowUpAt));
  }

```
In the `/* forged snapshots are refused */` block, after the check `"a completion snapshot claiming it was already done is refused"` add:
```ts
    const forgedClock = await reopenReminderAction({
      ...completion!, previousStatus: "pending",
      clearedFollowUp: { contactId: reminder.contactId!, previousNextFollowUpAt: "not a date", previousFollowUpStatus: "pending" },
    });
    check("a completion snapshot with a malformed clock is refused", forgedClock.restored === false);
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx scripts/smoke-toast-undo.ts`
Expected: FAIL with `completing the contact's follow-up reminder clears their follow-up clock failed` (the clock is still 4 days ago).

- [ ] **Step 3: Implement in `src/lib/reminders.ts`**

Line 1: add `isNull` to the existing drizzle import (keep every name already there), e.g.
```ts
import { and, asc, desc, eq, getTableColumns, inArray, isNull, sql, type SQL } from "drizzle-orm";
```
Replace the `CompletionSnapshot` type and `completeReminder` (from the `/** What \`completeReminder\` changed` comment through the function's closing brace) with:
```ts
/** What `completeReminder` changed, so an Undo can reverse exactly that and no more. */
export type CompletionSnapshot = {
  reminderId: string;
  previousStatus: string;
  closedActionItemIds: string[];
  /**
   * Present only when this completion also cleared the contact's follow-up clock, because the
   * reminder WAS that follow-up (same contact, same due instant). Optional so a snapshot minted
   * before the field existed still validates and still undoes.
   */
  clearedFollowUp?: {
    contactId: string;
    previousNextFollowUpAt: string;
    previousFollowUpStatus: string | null;
  };
};

export async function completeReminder(
  userId: string,
  reminderId: string
): Promise<CompletionSnapshot | null> {
  const db = await getDb();
  const reminder = await db.query.reminders.findFirst({
    where: and(eq(reminders.id, reminderId), eq(reminders.userId, userId)),
    columns: { status: true, contactId: true, dueDate: true },
  });
  if (!reminder) return null;

  // Read the contact's clock BEFORE any write, as `snoozeReminderTo` does, so Undo can put it back.
  const contact =
    reminder.contactId && reminder.dueDate
      ? await db.query.contacts.findFirst({
          where: and(eq(contacts.id, reminder.contactId), eq(contacts.userId, userId)),
          columns: { nextFollowUpAt: true, followUpStatus: true },
        })
      : null;

  await db
    .update(reminders)
    .set({ status: "done" })
    .where(and(eq(reminders.id, reminderId), eq(reminders.userId, userId)));

  // Only the OPEN items. This used to set every linked item to done, which also
  // re-stamped `completedAt` on items finished days earlier — a silent rewrite of when
  // they were done, and the reason an Undo could not tell which items it had closed.
  const closed = await db
    .update(actionItems)
    .set({ status: "done", completedAt: new Date() })
    .where(
      and(
        eq(actionItems.userId, userId),
        eq(actionItems.reminderId, reminderId),
        eq(actionItems.status, "open")
      )
    )
    .returning();

  // Every path that books a follow-up (scheduleContactFollowUpForUser, snoozeReminderTo, the
  // outreach queue, the extension, capture) writes the SAME instant to the reminder and to
  // `contacts.next_follow_up_at`. A match means this reminder IS the follow-up, so finishing it
  // finishes the follow-up. A different instant is a separate commitment and leaves the clock alone.
  let clearedFollowUp: CompletionSnapshot["clearedFollowUp"];
  if (
    reminder.contactId &&
    reminder.dueDate &&
    contact?.nextFollowUpAt &&
    contact.nextFollowUpAt.getTime() === reminder.dueDate.getTime()
  ) {
    await db
      .update(contacts)
      .set({ nextFollowUpAt: null, followUpStatus: "none", updatedAt: new Date() })
      .where(and(eq(contacts.id, reminder.contactId), eq(contacts.userId, userId)));
    clearedFollowUp = {
      contactId: reminder.contactId,
      previousNextFollowUpAt: contact.nextFollowUpAt.toISOString(),
      previousFollowUpStatus: contact.followUpStatus ?? null,
    };
  }

  return {
    reminderId,
    previousStatus: reminder.status,
    closedActionItemIds: closed.map((row) => row.id),
    ...(clearedFollowUp ? { clearedFollowUp } : {}),
  };
}
```
Before replacing, diff the old body against this one: any statement in the old body not shown here must be kept.

In `reopenReminder`, immediately before its final `return { restored: true };`, insert:
```ts
  // The clock only while it is still what the completion left (cleared): a follow-up booked
  // since is newer and wins — the same rule as `unsnoozeReminder`.
  if (snap.clearedFollowUp) {
    await db
      .update(contacts)
      .set({
        nextFollowUpAt: new Date(snap.clearedFollowUp.previousNextFollowUpAt),
        followUpStatus: snap.clearedFollowUp.previousFollowUpStatus,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(contacts.id, snap.clearedFollowUp.contactId),
          eq(contacts.userId, userId),
          isNull(contacts.nextFollowUpAt)
        )
      );
  }
```

- [ ] **Step 4: Implement in `src/actions/reminders.ts`**

Replace `validCompletionSnapshot`:
```ts
function validCompletionSnapshot(snap: CompletionSnapshot): boolean {
  const cleared = snap?.clearedFollowUp;
  return (
    typeof snap?.reminderId === "string" &&
    REMINDER_STATUSES.has(snap.previousStatus) &&
    snap.previousStatus !== "done" &&
    Array.isArray(snap.closedActionItemIds) &&
    snap.closedActionItemIds.length <= 500 &&
    snap.closedActionItemIds.every((id) => typeof id === "string") &&
    (cleared === undefined ||
      (typeof cleared?.contactId === "string" &&
        typeof cleared.previousNextFollowUpAt === "string" &&
        !Number.isNaN(Date.parse(cleared.previousNextFollowUpAt)) &&
        (cleared.previousFollowUpStatus === null ||
          FOLLOW_UP_STATUSES.has(cleared.previousFollowUpStatus))))
  );
}
```
Replace `markReminderDone` and `reopenReminderAction`:
```ts
export async function markReminderDone(id: string) {
  const userId = await requireUserId();
  const snapshot = await completeReminder(userId, id);
  revalidateReminderPaths(snapshot?.clearedFollowUp?.contactId);
  if (snapshot?.clearedFollowUp) revalidatePathIfRequestScoped("/contacts");
  // Handed back so the toast can offer Undo; see `reopenReminderAction`.
  return snapshot;
}

/** Undo for `markReminderDone`. */
export async function reopenReminderAction(snapshot: CompletionSnapshot) {
  const userId = await requireUserId();
  if (!validCompletionSnapshot(snapshot)) return { restored: false };
  const result = await reopenReminder(userId, snapshot);
  revalidateReminderPaths(snapshot.clearedFollowUp?.contactId);
  if (snapshot.clearedFollowUp) revalidatePathIfRequestScoped("/contacts");
  return result;
}
```
`FOLLOW_UP_STATUSES` is declared near line 84. If `revalidatePathIfRequestScoped` is not imported here, import it from wherever `src/lib/reminder-writes.ts` imports it.

- [ ] **Step 5: Run and confirm it passes**

Run: `npx tsx scripts/smoke-toast-undo.ts && npx tsx scripts/smoke-follow-up-actions.ts && npx tsc --noEmit -p .`
Expected: both smokes all ok; tsc exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reminders.ts src/actions/reminders.ts scripts/smoke-toast-undo.ts
git commit -m "Reminders: finishing a contact's follow-up clears their follow-up clock

Same contact + same due instant means the reminder IS the follow-up. The
completion snapshot carries the old clock so Undo restores it, but never
over a follow-up booked since.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: A booked follow-up is listed once, and the date picker keeps a hand-written title (R2, R8a)

**Files:**
- Modify: `src/lib/notification-panel.ts:149-172`
- Modify: `src/lib/reminders.ts:764-795` (`loadDashboardReminders` filter + JSDoc)
- Modify: `src/actions/reminders.ts:606-614` (`scheduleContactFollowUpAt` update branch)
- Test: `scripts/smoke-follow-up-actions.ts`, `scripts/smoke-bounded-reads.ts` (both pglite, registered)

**Interfaces:**
- Produces: the dedupe rule "generated, or same instant and title `Follow up with <preferredName || fullName>`", used identically in JS (bell) and SQL (dashboard).

- [ ] **Step 1: Write the failing checks in `scripts/smoke-follow-up-actions.ts`**

Imports become (keep any other names already imported):
```ts
import { loadDashboardReminders, snoozeReminder } from "../src/lib/reminders";
import { loadNotificationPanel } from "../src/lib/notification-panel";
import {
  clearContactFollowUp,
  scheduleContactFollowUp,
  scheduleContactFollowUpAt,
} from "../src/actions/reminders";
```
Immediately before the section comment that mentions `clearing reports what it actually closed`, insert:
```ts
  /* --------------- a booked follow-up is ONE item once due, not a reminder AND a row */

  const booked = await seedContact("Hannah Lowe", 0);
  await scheduleContactFollowUp(booked.id, 2);
  // Let it come due: move both halves of the pair back by the same instant, as time would.
  const past = new Date(Date.now() - 3_600_000);
  await db.update(reminders).set({ dueDate: past })
    .where(and(eq(reminders.contactId, booked.id), eq(reminders.status, "pending")));
  await db.update(contacts).set({ nextFollowUpAt: past }).where(eq(contacts.id, booked.id));

  const panel = await loadNotificationPanel(USER, new Date(), { withAlerts: false });
  const bookedDue = panel.items.filter((i) => i.contactId === booked.id && i.urgency === "due");
  check("a booked follow-up shows once in the bell once due", bookedDue.length === 1,
    JSON.stringify(bookedDue.map((i) => i.kind)));
  const dash = await loadDashboardReminders(USER, new Date());
  check("…and not again on the dashboard's Reminders card",
    !dash.rows.some((r) => r.contactId === booked.id));

  await db.insert(reminders).values({
    userId: USER, contactId: booked.id, title: HANDWRITTEN, dueDate: past,
    reminderType: "manual", status: "pending", createdBy: "user",
  });
  const panel2 = await loadNotificationPanel(USER, new Date(), { withAlerts: false });
  check("a hand-written reminder at the same instant is still listed",
    panel2.items.some((i) => i.contactId === booked.id && i.title === HANDWRITTEN));
  const dash2 = await loadDashboardReminders(USER, new Date());
  check("…on the dashboard too", dash2.rows.some((r) => r.title === HANDWRITTEN && r.contactId === booked.id));

  /* --------------- the date picker moves a hand-written reminder without renaming it */

  const pickerContact = await seedContact("Rowan Ellis", 0);
  const [pickerHandwritten] = await db.insert(reminders).values({
    userId: USER, contactId: pickerContact.id, title: HANDWRITTEN, dueDate: new Date(),
    reminderType: "note_action", status: "pending", createdBy: "user",
  }).returning();
  const inTen = new Date(); inTen.setDate(inTen.getDate() + 10);
  const ymd = `${inTen.getFullYear()}-${String(inTen.getMonth() + 1).padStart(2, "0")}-${String(inTen.getDate()).padStart(2, "0")}`;
  await scheduleContactFollowUpAt(pickerContact.id, ymd);
  const afterPicker = await db.query.reminders.findFirst({ where: eq(reminders.id, pickerHandwritten.id) });
  check("the date picker preserves a hand-written reminder title",
    afterPicker?.title === HANDWRITTEN, `got ${JSON.stringify(afterPicker?.title)}`);
  check("…and its type", afterPicker?.reminderType === "note_action", `got ${afterPicker?.reminderType}`);
  check("…while moving it to the picked day", daysFromToday(afterPicker?.dueDate) === 10,
    `got ${daysFromToday(afterPicker?.dueDate)}`);
```
Check the real signatures first (`grep -n "export async function loadNotificationPanel\|export async function loadDashboardReminders" -A6 src/lib/*.ts`). If the third argument or the `.rows` field differ, adapt the calls; the assertions stay the same. If a reminders insert needs more columns, tsc will name them.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx scripts/smoke-follow-up-actions.ts`
Expected: FAIL at `a booked follow-up shows once in the bell once due` with detail `["reminder","follow_up"]`.

- [ ] **Step 3: Bell dedupe (`src/lib/notification-panel.ts`)**

Replace the `dueFollowUpContactIds` set and the skip at the top of `for (const r of pendingReminders)` with:
```ts
  const dueFollowUpContacts = new Map(
    contactRows
      .filter((c) => c.nextFollowUpAt && new Date(c.nextFollowUpAt) <= now)
      .map((c) => [c.id, c])
  );

  for (const r of pendingReminders) {
    // Also skipped: the reminder a day preset books beside the contact's clock — same
    // instant, the scheduler's own wording. It IS the follow-up row below, so it used to be
    // listed (and counted in `dueCount`) twice. A hand-written reminder that merely shares
    // the instant ("Send Sarah the write-up") is still its own thing and still listed.
    const pair = r.contactId ? dueFollowUpContacts.get(r.contactId) : undefined;
    if (
      pair &&
      (r.reminderType === "generated" ||
        (r.dueDate !== null &&
          new Date(r.dueDate).getTime() === new Date(pair.nextFollowUpAt!).getTime() &&
          r.title === `Follow up with ${pair.preferredName || pair.fullName}`))
    ) {
      continue;
    }
```
Rename every other use of `dueFollowUpContactIds` in the file to `dueFollowUpContacts` (`.has()` works on a Map). Make sure `contactRows` selects `preferredName` and `fullName`. Update the comment block above to name both rules.

- [ ] **Step 4: Dashboard dedupe (`src/lib/reminders.ts`, `loadDashboardReminders`)**

Replace the `sql\`not ( ... )\`` filter with:
```ts
        // Drops a reminder whose contact is on the due list when it is either generated, or
        // the reminder a day preset booked beside the clock (same instant, the scheduler's own
        // wording). `exists` is never NULL, so this NOT never meets one.
        sql`not (
          ${reminders.contactId} is not null
          and exists (
            select 1 from ${contacts} due
            where due.id = ${reminders.contactId}
              and due.user_id = ${userId}
              and ${followUpDueSql(sql.raw("due"), now)}
              and (
                ${reminders.reminderType} = 'generated'
                or (
                  due.next_follow_up_at = ${reminders.dueDate}
                  and ${reminders.title} = 'Follow up with ' || coalesce(nullif(due.preferred_name, ''), due.full_name)
                )
              )
          )
        )`
```
Confirm column names with `grep -n "preferred_name\|next_follow_up_at\|full_name" src/db/schema.ts`. Update the function's JSDoc to describe the second rule in one sentence.

- [ ] **Step 5: Keep `scripts/smoke-bounded-reads.ts`'s JS reference in step**

In its dashboard-reminders section, after the existing seed rows for the due contact add:
```ts
    rem({ title: "Follow up with Due Dana", contactId: due.id, dueDate: at(-1) }), // the booked pair (dropped)
    rem({ title: "Follow up with Due Dana", contactId: due.id, dueDate: at(-3) }), // same words, other instant (kept)
```
(`at(-1)` must equal the due contact's `nextFollowUpAt`; if the contact is not named "Due Dana" or the helpers differ, use the real ones.) Replace the contact scan and the `expectedReminders` filter with:
```ts
  const scan = await db.query.contacts.findMany({ where: eq(contacts.userId, DASH_USER), columns: { id: true, nextFollowUpAt: true, fullName: true, preferredName: true } });
  const scanById = new Map(scan.map((c) => [c.id, c]));
```
```ts
  const expectedReminders = pending.filter((r) => {
    if (!r.contactId || !dueFollowUpIds.has(r.contactId)) return true;
    if (r.reminderType === "generated") return false;
    const c = scanById.get(r.contactId)!;
    return !(
      r.dueDate &&
      new Date(r.dueDate).getTime() === new Date(c.nextFollowUpAt!).getTime() &&
      r.title === `Follow up with ${c.preferredName || c.fullName}`
    );
  });
```
Keep however `dueFollowUpIds` is derived from `scan` today.

- [ ] **Step 6: R8a (`src/actions/reminders.ts`, `scheduleContactFollowUpAt`)**

In the `if (existing)` branch, replace the `.set({ title, dueDate: due, reminderType: "manual", actionKind, listId: ... })` with:
```ts
      // WHEN, not WHAT — same rule as `scheduleContactFollowUpForUser`: a hand-written
      // "Send Priya the deck" must not be renamed "Follow up with Priya" by the date picker.
      .set({
        dueDate: due,
        listId: existing.listId || inboxId,
      })
```
`title` and `actionKind` stay declared (the insert branch uses them).

- [ ] **Step 7: Run and confirm**

Run: `npx tsx scripts/smoke-follow-up-actions.ts && npx tsx scripts/smoke-bounded-reads.ts && npx tsx scripts/smoke-behavior-golden.ts && npx tsc --noEmit -p .`
Expected: all ok. If `smoke-behavior-golden` reports a changed dashboard snapshot, the only acceptable difference is a dropped `Follow up with <name>` row at its contact's own instant; update its baseline the way that script's header describes.

- [ ] **Step 8: Commit**

```bash
git add src/lib/notification-panel.ts src/lib/reminders.ts src/actions/reminders.ts scripts/smoke-follow-up-actions.ts scripts/smoke-bounded-reads.ts
git commit -m "Follow-ups: a booked follow-up is listed once; the date picker keeps a hand-written title

The bell and dashboard dropped only generated reminders beside a due
contact, so a day preset's own reminder doubled the row and the badge.
A hand-written reminder at the same instant is still listed.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The bell's "Mark done" on a follow-up can be undone (R3)

**Files:**
- Modify: `src/lib/reminder-writes.ts` (imports ~13, ~22; `clearContactFollowUpForUser` ~189-212; new `undoClearContactFollowUpForUser`)
- Modify: `src/actions/reminders.ts` (import ~39-44; `clearContactFollowUp` ~694-702; new `undoClearContactFollowUpAction`)
- Modify: `src/components/notifications/notifications-panel.tsx` (import ~27-33; `clearFollowUp` ~186-200)
- Test: `scripts/smoke-toast-undo.ts`

**Interfaces:**
- Consumes: `CompletionSnapshot`, `completeReminder`, `reopenReminder`, `validCompletionSnapshot` (Task 1).
- Produces: `type ClearFollowUpSnapshot = { contactId: string; previousNextFollowUpAt: string | null; previousFollowUpStatus: string | null; completions: CompletionSnapshot[] }`; `clearContactFollowUp(contactId) → { ok: true; remindersClosed: number; snapshot: ClearFollowUpSnapshot }`; `undoClearContactFollowUpAction(snapshot) → { restored: boolean }`.

- [ ] **Step 1: Write the failing checks**

In `scripts/smoke-toast-undo.ts` add `clearContactFollowUp, undoClearContactFollowUpAction,` to the `../src/actions/reminders` import. Before `/* ------------------------------------------------ forged snapshots are refused */` add:
```ts
  /* --------------------------------- clear follow-up → one Undo puts it all back */

  {
    const { contact, reminder, originalDue } = await seedReminder("Quinn Avery");
    const cleared = await clearContactFollowUp(contact.id);
    check("clearing hands back a snapshot naming what it closed",
      cleared.snapshot?.completions.length === 1 && cleared.snapshot.completions[0].reminderId === reminder.id,
      JSON.stringify(cleared.snapshot));

    const result = await undoClearContactFollowUpAction(cleared.snapshot);
    check("Undo reports it restored", result.restored);
    const r = await db.query.reminders.findFirst({ where: eq(reminders.id, reminder.id) });
    check("the reminder it closed is pending again", r?.status === "pending");
    const c = await db.query.contacts.findFirst({ where: eq(contacts.id, contact.id) });
    check("the follow-up clock is back exactly",
      ms(c?.nextFollowUpAt) === ms(originalDue) && c?.followUpStatus === "pending");

    const again = await undoClearContactFollowUpAction(cleared.snapshot);
    check("a second Undo finds nothing to restore", again.restored === false);
    const forged = await undoClearContactFollowUpAction({ ...cleared.snapshot, previousFollowUpStatus: "exploded" });
    check("a forged clear snapshot is refused", forged.restored === false);
  }

```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx scripts/smoke-toast-undo.ts`
Expected: FAIL (import error, or `clearing hands back a snapshot naming what it closed failed`).

- [ ] **Step 3: Implement in `src/lib/reminder-writes.ts`**

Imports: the drizzle import gains `isNull` (`import { and, eq, isNull } from "drizzle-orm";`, keeping other names) and the reminders import becomes `import { completeReminder, reopenReminder, type CompletionSnapshot } from "@/lib/reminders";` (keeping other names).

Replace `clearContactFollowUpForUser` (and its doc comment) with:
```ts
/** What `clearContactFollowUpForUser` changed, so an Undo can put exactly that back. */
export type ClearFollowUpSnapshot = {
  contactId: string;
  previousNextFollowUpAt: string | null;
  previousFollowUpStatus: string | null;
  completions: CompletionSnapshot[];
};

/**
 * Clears a contact's due follow-up and completes every pending reminder for them. Takes a
 * `userId` so the email dispatcher can call it from the drain, where there is no request;
 * `clearContactFollowUp` (the action) is a wrapper. Revalidation is a no-op outside a request.
 */
export async function clearContactFollowUpForUser(
  userId: string,
  contactId: string
): Promise<{ remindersClosed: number; snapshot: ClearFollowUpSnapshot }> {
  const db = await getDb();
  const before = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    columns: { nextFollowUpAt: true, followUpStatus: true },
  });
  await db
    .update(contacts)
    .set({ nextFollowUpAt: null, followUpStatus: "none", updatedAt: new Date() })
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
  const open = await db.query.reminders.findMany({
    where: and(eq(reminders.userId, userId), eq(reminders.contactId, contactId), eq(reminders.status, "pending")),
  });
  const completions: CompletionSnapshot[] = [];
  for (const r of open) {
    const snap = await completeReminder(userId, r.id);
    if (snap) completions.push(snap);
  }
  revalidateReminderPaths(contactId);
  revalidatePathIfRequestScoped("/contacts");
  return {
    remindersClosed: open.length,
    snapshot: {
      contactId,
      previousNextFollowUpAt: before?.nextFollowUpAt ? before.nextFollowUpAt.toISOString() : null,
      previousFollowUpStatus: before?.followUpStatus ?? null,
      completions,
    },
  };
}

/**
 * Reverse a `clearContactFollowUpForUser`: each reminder through `reopenReminder` (its own
 * still-done guard), and the clock only while it is still cleared — a follow-up booked since
 * is newer and wins.
 */
export async function undoClearContactFollowUpForUser(
  userId: string,
  snap: ClearFollowUpSnapshot
): Promise<{ restored: boolean }> {
  const db = await getDb();
  let reopened = 0;
  for (const c of snap.completions) {
    if ((await reopenReminder(userId, c)).restored) reopened++;
  }
  const clock = snap.previousNextFollowUpAt
    ? await db
        .update(contacts)
        .set({
          nextFollowUpAt: new Date(snap.previousNextFollowUpAt),
          followUpStatus: snap.previousFollowUpStatus,
          updatedAt: new Date(),
        })
        .where(and(eq(contacts.id, snap.contactId), eq(contacts.userId, userId), isNull(contacts.nextFollowUpAt)))
        .returning() // bare: a field selector breaks over the Db union
    : [];
  return { restored: reopened > 0 || clock.length > 0 };
}
```

- [ ] **Step 4: Actions (`src/actions/reminders.ts`)**

Add `undoClearContactFollowUpForUser` and `type ClearFollowUpSnapshot` to the `@/lib/reminder-writes` import. Replace `clearContactFollowUp`:
```ts
export async function clearContactFollowUp(contactId: string) {
  const userId = await requireUserId();
  const { remindersClosed, snapshot } = await clearContactFollowUpForUser(userId, contactId);
  // The count is load-bearing, not telemetry: clearing a follow-up also marks every
  // pending reminder for the contact done (and completes their linked action items),
  // which the caller has to be able to say out loud. The snapshot is what lets it offer Undo.
  return { ok: true, remindersClosed, snapshot };
}

/** Undo for `clearContactFollowUp`. The snapshot comes back from the client: validated. */
export async function undoClearContactFollowUpAction(snapshot: ClearFollowUpSnapshot) {
  const userId = await requireUserId();
  if (
    typeof snapshot?.contactId !== "string" ||
    !isIsoOrNull(snapshot.previousNextFollowUpAt) ||
    !(snapshot.previousFollowUpStatus === null || FOLLOW_UP_STATUSES.has(snapshot.previousFollowUpStatus)) ||
    !Array.isArray(snapshot.completions) ||
    snapshot.completions.length > BULK_LIMIT ||
    !snapshot.completions.every(validCompletionSnapshot)
  ) {
    return { restored: false };
  }
  const result = await undoClearContactFollowUpForUser(userId, snapshot);
  revalidateReminderPaths(snapshot.contactId);
  revalidatePathIfRequestScoped("/contacts");
  return result;
}
```
`isIsoOrNull` (~line 87) and `BULK_LIMIT` (~line 876) already exist in this file.

- [ ] **Step 5: Offer Undo in the bell (`src/components/notifications/notifications-panel.tsx`)**

Add `undoClearContactFollowUpAction` to the `@/actions/reminders` import. Replace `clearFollowUp` and the comment above it:
```ts
  // Undo puts back the contact's clock and every reminder this closed, each behind its own
  // staleness guard — the snapshot names them, where the bare count could not.
  function clearFollowUp(contactId: string) {
    start(() =>
      runToastAction({
        run: () => clearContactFollowUp(contactId),
        success: (res) =>
          res.remindersClosed > 0
            ? `Follow-up cleared — ${res.remindersClosed} ${res.remindersClosed === 1 ? "reminder" : "reminders"} closed too`
            : "Follow-up cleared",
        failure: "Couldn’t clear that follow-up — try again?",
        refresh,
        undo: (res) => () => undoClearContactFollowUpAction(res.snapshot),
      }).then(() => undefined)
    );
  }
```
If the existing `success`/`failure` copy differs, keep it; the change is the `undo` line.

- [ ] **Step 6: Run and confirm**

Run: `npx tsx scripts/smoke-toast-undo.ts && npx tsx scripts/smoke-follow-up-actions.ts && npx tsc --noEmit -p .`
Expected: all ok. tsc will flag any caller of `clearContactFollowUpForUser` that depended on the old return type; adapt it to `{ remindersClosed, snapshot }`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/reminder-writes.ts src/actions/reminders.ts src/components/notifications/notifications-panel.tsx scripts/smoke-toast-undo.ts
git commit -m "Bell: clearing a follow-up can be undone

clearContactFollowUp now returns a snapshot of the old clock and every
reminder it closed; Undo restores each behind its own staleness guard.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The interaction sheet's edit form only saves to the interaction it opened on (C1)

**Files:**
- Create: `src/lib/interaction-edit.ts`
- Modify: `src/components/contacts/interaction-detail-sheet.tsx` (~118, `close` ~149-155, `beginEdit`/`saveEdit` ~159-185, chevrons ~291/~301, Cancel ~550)
- Test: Create `scripts/smoke-interaction-edit.ts` (pure); register

**Interfaces:**
- Produces: `editTarget(editingId: string | null, interactionId: string | null): string | null`.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-interaction-edit.ts`:
```ts
/**
 * The interaction sheet's edit form follows the interaction it was seeded from. Stepping to
 * another interaction while editing used to keep the form open and save A's notes onto B.
 *
 * Pure: no database. Run: npx tsx scripts/smoke-interaction-edit.ts
 */
import { readFileSync } from "node:fs";
import { editTarget } from "../src/lib/interaction-edit";

function check(label: string, condition: boolean) {
  if (!condition) throw new Error(`${label} failed`);
  console.log(`  ok  ${label}`);
}

check("editing A while A is open targets A", editTarget("a", "a") === "a");
check("stepping to B closes the form", editTarget("a", "b") === null);
check("the sheet losing its row under a refresh closes the form", editTarget("a", null) === null);
check("not editing targets nothing", editTarget(null, "a") === null);

const sheet = readFileSync("src/components/contacts/interaction-detail-sheet.tsx", "utf8");
check("the sheet derives editing from editTarget", /editTarget\(editingId, interactionId\)/.test(sheet));
check("both step chevrons are disabled while editing",
  /disabled=\{pending \|\| editing \|\| !canStep\.newer\}/.test(sheet) &&
    /disabled=\{pending \|\| editing \|\| !canStep\.older\}/.test(sheet));
check("no setEditing state remains", !/\bsetEditing\(/.test(sheet));

console.log("\nsmoke-interaction-edit: all checks passed");
process.exit(0);
```
Register in `scripts/run-smoke.ts` `MANIFEST`, pure block:
```ts
  "smoke-interaction-edit": "pure",
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx scripts/smoke-interaction-edit.ts`
Expected: FAIL — cannot find module `../src/lib/interaction-edit`.

- [ ] **Step 3: Create `src/lib/interaction-edit.ts`**

```ts
/** The interaction an open edit form may write to: only the one its fields were seeded from. */
export function editTarget(editingId: string | null, interactionId: string | null): string | null {
  return editingId !== null && editingId === interactionId ? editingId : null;
}
```

- [ ] **Step 4: Rewire the sheet**

In `src/components/contacts/interaction-detail-sheet.tsx` add `import { editTarget } from "@/lib/interaction-edit";`.

Replace `const [editing, setEditing] = useState(false);` with:
```ts
  const [editingId, setEditingId] = useState<string | null>(null);
  // Derived, like `loading`: the form is open only on the interaction its fields were seeded
  // from. Stepping away, or the sheet losing its row under a refresh, closes it with no
  // effect to keep in step, and Save can only write to the id the fields came from.
  const editing = editTarget(editingId, interactionId) !== null;
```
In `close()`, replace `setEditing(false);` with `setEditingId(null);`.

Replace `beginEdit` and `saveEdit`:
```ts
  function beginEdit() {
    // The footer still shows while the next interaction loads; don't seed from the old one.
    if (!detail || detail.id !== interactionId) return;
    setFormType(normalizeInteractionType(detail.interactionType));
    setFormDate(format(new Date(detail.interactionDate), "yyyy-MM-dd"));
    setFormSummary((detail.aiSummary || "").trim());
    setFormNotes((detail.rawNotes || "").trim());
    setEditingId(detail.id);
  }

  function saveEdit() {
    const id = editTarget(editingId, interactionId);
    if (!id) return;
    start(async () => {
      try {
        await updateInteraction(id, {
          interactionType: formType,
          interactionDate: formDate,
          aiSummary: formSummary.trim(),
          rawNotes: formNotes.trim(),
        });
        toast.success("Interaction updated");
        setEditingId(null);
        await load(id);
        router.refresh();
      } catch (err) {
        toast.error(friendlyError(err, TOAST_COPY.saveFailed));
      }
    });
  }
```
Read the existing `saveEdit` first: if its payload, toast or catch differ, keep them and change only the id source and `setEditingId(null)`.

Chevrons: `disabled={pending || editing || !canStep.newer}` and `disabled={pending || editing || !canStep.older}`. Cancel: `onClick={() => setEditingId(null)}`.

- [ ] **Step 5: Run and confirm**

Run: `npx tsx scripts/smoke-interaction-edit.ts && npx tsx scripts/run-smoke.ts --check && npx tsc --noEmit -p .`
Expected: all ok.

- [ ] **Step 6: Commit**

```bash
git add src/lib/interaction-edit.ts src/components/contacts/interaction-detail-sheet.tsx scripts/smoke-interaction-edit.ts scripts/run-smoke.ts
git commit -m "Interactions: an edit form can only save to the interaction it opened on

Stepping Newer/Older while editing kept A's fields and saved them onto B.
editing is now derived from the seeded id, and the chevrons lock while
editing.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Saving a note into an existing contact keeps their hand-set closeness (C2)

**Files:**
- Modify: `src/lib/note-batch-save.ts` (participant type after `relationshipScore: number;` ~59; merge destructure ~284; merge update spread ~315)
- Modify: `src/lib/capture/types.ts` (`CaptureDecision` after `relationshipScore: number;` ~244)
- Modify: `src/lib/capture-job-runner.ts` (~457; export `saveInputFromParse` if not exported)
- Modify: `src/components/capture/review/person-card.tsx` (~18-22, ~125)
- Modify: `src/components/capture/person-edit-dialog.tsx` (~100)
- Modify: `src/components/capture/review/person-deck.tsx` (~64, ~73)
- Modify: `src/components/chat/bulk-notes-panel.tsx` (~96, ~551, ~1694)
- Test: Create `scripts/smoke-merge-closeness.ts` (pglite); register

**Interfaces:**
- Produces: `closenessChosen?: boolean` on `NoteBatchParticipantInput`, `CaptureDecision`, `PersonDraft`, and the bulk panel's `ReviewItem`. Absent means "model suggestion".

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-merge-closeness.ts`:
```ts
/**
 * Saving a note into an EXISTING contact keeps the closeness someone set by hand, unless they
 * picked a new one on the card. The profile's "Log interaction" sheet has no closeness
 * control, yet used to write the model's guess over the rating.
 * Run: npx tsx scripts/smoke-merge-closeness.ts
 */
import "./smoke/_env";
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-merge-closeness";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-merge-closeness";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, noteBatches, reminders, userSettings } from "../src/db/schema";
import { saveNoteBatch, type NoteBatchParticipantInput } from "../src/lib/note-batch-save";
import { saveInputFromParse } from "../src/lib/capture-job-runner";
import type { BulkNotePersonPreview, CaptureParseResult } from "../src/lib/capture/types";
import { hashSourceNote } from "../src/lib/suggested-reminder-utils";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-merge-closeness-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function reset() {
  const db = await getDb();
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(noteBatches).where(eq(noteBatches.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);
}

function parsed(name: string) {
  return {
    name, company: null, role: null, presence: "participant" as const, location: null, email: null, linkedin_url: null, met_at: null,
    topics: [], action_items: [], follow_up_recommendation: null, follow_up_days: null,
    relationship_score_suggestion: 2, relevance: null, tags: [], summary: `Chat with ${name}`, key_facts: [], opportunities: [], implied_next_steps: [],
    shared_interests: [], suggested_next_message: null, confidence: 0.9, interaction_date: "2026-09-01", low_confidence_fields: [],
  };
}

async function save(note: string, p: Omit<NoteBatchParticipantInput, "notes" | "parsed" | "createReminder" | "tagNames">) {
  await saveNoteBatch(USER, {
    sourceText: note, sourceHash: hashSourceNote(note), anchorIso: "2026-09-01", anchorBasis: "note", entryPoint: "profile",
    participants: [{ notes: note, parsed: parsed("Priya Raman"), createReminder: false, tagNames: [], ...p }],
    commitments: [], skipped: { relative: 0, unverifiable: 0, past: 0 },
  });
}

async function main() {
  await reset();
  const db = await getDb();
  const [priya] = await db.insert(contacts).values({ userId: USER, fullName: "Priya Raman", relationshipScore: 5, statedCloseness: 5 }).returning();
  const read = async () => (await db.query.contacts.findFirst({ where: eq(contacts.id, priya.id) }))!;

  // 1. The profile sheet's call shape: a model suggestion, no control touched.
  await save("Coffee with Priya.", { mergeContactId: priya.id, relationshipScore: 2 });
  let row = await read();
  check("a logged note keeps the hand-set closeness", row.relationshipScore === 5 && row.statedCloseness === 5, JSON.stringify([row.relationshipScore, row.statedCloseness]));

  // 2. A closeness the person picked on the card still lands.
  await save("Dinner with Priya.", { mergeContactId: priya.id, relationshipScore: 4, closenessChosen: true });
  row = await read();
  check("a chosen closeness is written on merge", row.relationshipScore === 4 && row.statedCloseness === 4, JSON.stringify([row.relationshipScore, row.statedCloseness]));

  // 3. The capture deck: the decision's flag reaches the participant; absent means not chosen.
  const item = { key: "0-Priya Raman", notes: "x", parsed: parsed("Priya Raman"), duplicates: [], suggestedMergeId: priya.id, interactionDate: null, interactionType: "note" } as unknown as BulkNotePersonPreview;
  const result = { items: [item, { ...item, key: "1-Priya Raman" }], sharedNotes: [], interactionDate: null, interactionType: "note", anchorIso: "2026-09-01", anchorBasis: "note", hints: {}, sourceText: "x", sourceHash: hashSourceNote("x"), suggestedReminders: [], suggestionsSkipped: { relative: 0, unverifiable: 0, past: 0 }, mentions: [], mentionedOnly: [] } as unknown as CaptureParseResult;
  const built = await saveInputFromParse({
    userId: USER, result, sourceText: "x", sourceHash: null, entryPoint: "capture", seedContactId: null, inputSources: [], meetingSessionId: null,
    decisions: { people: {
      "0-Priya Raman": { decision: "accept", index: 0, mergeContactId: priya.id, relationshipScore: 3, tagNames: [], decidedAt: "" },
      "1-Priya Raman": { decision: "accept", index: 1, mergeContactId: priya.id, relationshipScore: 3, tagNames: [], decidedAt: "", closenessChosen: true },
    } },
  });
  check("deck: an untouched card is not a choice", built.participants[0].closenessChosen !== true);
  check("deck: a touched card carries the choice", built.participants[1].closenessChosen === true);

  await reset();
  console.log("\nsmoke-merge-closeness: all checks passed");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
```
If `saveInputFromParse` is not exported (`grep -n "saveInputFromParse" src/lib/capture-job-runner.ts`), export it. If its argument object takes different keys, read its parameter type and pass those; keep the two decision fixtures. Register next to `"smoke-note-batch": "pglite",`:
```ts
  "smoke-merge-closeness": "pglite",
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx tsx scripts/smoke-merge-closeness.ts`
Expected: FAIL `a logged note keeps the hand-set closeness failed: [2,2]`.

- [ ] **Step 3: Save rule (`src/lib/note-batch-save.ts`)**

In the participant input type, after `relationshipScore: number;`:
```ts
  /**
   * The person picked `relationshipScore` themselves (touched a closeness control). A merge
   * writes the score only then: a model suggestion must never overwrite a rating someone set
   * by hand. Creates always write it — there is nothing to overwrite.
   */
  closenessChosen?: boolean;
```
In the merge branch, make the destructure also pull out the closeness fields (keep the other names already there):
```ts
        const { tagNames, phone, xHandle, website, school, industry, keyFacts: noteFacts, relationshipScore, statedCloseness, ...rest } = fields;
```
Directly after `...rest,` inside that branch's `updateContactForUser` payload:
```ts
            // updateContactForUser mirrors this into statedCloseness.
            ...(p.closenessChosen ? { relationshipScore } : {}),
```
(`p` is the participant variable in that loop; use its real name.)

- [ ] **Step 4: Carry the flag from every closeness control**

- `src/lib/capture/types.ts`, `CaptureDecision`, after `relationshipScore: number;`:
  ```ts
  /** The person moved the closeness control. Absent = the model's suggestion, never written over an existing contact's rating. */
  closenessChosen?: boolean;
  ```
- `src/lib/capture-job-runner.ts`, after `relationshipScore: facts.closeness,`:
  ```ts
      closenessChosen: decision.closenessChosen === true,
  ```
  (use the local name holding the `CaptureDecision` there).
- `src/components/capture/review/person-card.tsx`: `PersonDraft` gains `closenessChosen?: boolean;`; the closeness control's `onChange` becomes `onChange={(closeness) => onDraft({ closeness, closenessChosen: true })}`.
- `src/components/capture/person-edit-dialog.tsx`: `onChange={(closeness) => setDraft((d) => ({ ...d, closeness, closenessChosen: true }))}`.
- `src/components/capture/review/person-deck.tsx`: where the draft is seeded add `closenessChosen: decision?.closenessChosen ?? false,` beside `closeness:`; in `decisionFromDraft` add `closenessChosen: draft.closenessChosen ?? false,` beside `relationshipScore: draft.closeness,`.
- `src/components/chat/bulk-notes-panel.tsx`: `ReviewItem` gains `closenessChosen?: boolean;`; the save mapping adds `closenessChosen: i.closenessChosen === true,` beside `relationshipScore: i.relationshipScore,`; the closeness number input's change sets `closenessChosen: true` beside `relationshipScore: Number(e.target.value),`.

`log-interaction-sheet.tsx` and `drive-import-processor.ts` are unchanged: they never set the flag, so their merges keep the existing rating.

- [ ] **Step 5: Run and confirm**

Run: `npx tsx scripts/smoke-merge-closeness.ts && npx tsx scripts/smoke-capture-jobs.ts && npx tsx scripts/smoke-note-batch.ts && npx tsx scripts/run-smoke.ts --check && npx tsc --noEmit -p .`
Expected: all ok.

- [ ] **Step 6: Commit**

```bash
git add src/lib/note-batch-save.ts src/lib/capture/types.ts src/lib/capture-job-runner.ts src/components/capture src/components/chat/bulk-notes-panel.tsx scripts/smoke-merge-closeness.ts scripts/run-smoke.ts
git commit -m "Notes: merging into a contact keeps their hand-set closeness

Profile log sheet, Drive import and untouched capture cards wrote the
model's guess over the rating. A merge now writes closeness only when a
person touched a closeness control (closenessChosen).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: A coming-soon page refuses its server actions (E1)

**Files:**
- Modify: `src/lib/surface-visibility.ts` (after `requireVisibleSurface`, ~270)
- Modify: `src/lib/plan-guards.ts` (import line 3; `requireOutreachUser` ~43; append `requireUserForReleasedSurface`)
- Modify: `src/actions/radar.ts`, `src/actions/events.ts`
- Modify: `scripts/smoke-outreach-guards.ts`, `scripts/smoke-batched-writes.ts`, `scripts/smoke-bounded-reads.ts` (release Outreach in their throwaway DB)
- Modify (optional): `scripts/smoke-action-user-scope.ts` (~53)
- Test: `scripts/smoke-surface-visibility.ts`, `scripts/smoke-outreach-guards.ts`

**Interfaces:**
- Produces: `requireReleasedSurface(userId, surfaceKey): Promise<void>` (throws `SurfaceHiddenError`), `requireUserForReleasedSurface(surfaceKey): Promise<string>`. Task 7 relies on the Outreach release line added to `smoke-outreach-guards.ts` here.

- [ ] **Step 1: Write the failing checks**

`scripts/smoke-surface-visibility.ts`: add `requireReleasedSurface` (and `requireVisibleSurface`, `setSurfaceComingSoon` if not already) to the `../src/lib/surface-visibility` import; add
```ts
import { readFileSync } from "node:fs";
import { callsIn } from "./smoke-connect-gates";
```
Directly after `check("an always-visible surface is never refused", dashboardOk);` insert:
```ts
    console.log("\ncoming-soon closes actions, not just pages");
    {
      const SOON = [...DEFAULT_COMING_SOON_KEYS].find(
        (k) => getSurface(k)?.kind === "page" && k !== target.key
      )!;
      let thrown: unknown = null;
      try { await requireReleasedSurface(USER, SOON); } catch (err) { thrown = err; }
      check("a coming-soon surface refuses its actions", isSurfaceHiddenError(thrown), SOON);
      let older: unknown = null;
      try { await requireVisibleSurface(USER, SOON); } catch (err) { older = err; }
      check("while requireVisibleSurface still lets them through", older === null);
      let always: unknown = null;
      try { await requireReleasedSurface(USER, "page.dashboard"); } catch (err) { always = err; }
      check("an always-visible surface is never refused", always === null);
      let released: unknown = null;
      try {
        await setSurfaceComingSoon(ADMIN, SOON, false); // writes live:<SOON>, as /admin/product does
        try { await requireReleasedSurface(USER, SOON); } catch (err) { released = err; }
      } finally {
        await setSurfaceComingSoon(ADMIN, SOON, true); // back to the code default
      }
      check("a live: override releases its actions too", released === null);

      for (const file of ["src/actions/radar.ts", "src/actions/events.ts"]) {
        check(`${file} never uses the visibility-only guard`, !/requireUserForSurface\(/.test(readFileSync(file, "utf8")));
      }
      check("requireOutreachUser requires a released surface",
        callsIn("src/lib/plan-guards.ts", "requireOutreachUser").has("requireReleasedSurface"));
      for (const fn of ["connectLuma", "connectEventFeed", "setGmailEventScan", "startEventbriteOAuth"]) {
        check(`${fn} requires Events to be released`, callsIn("src/actions/events.ts", fn).has("requireReleasedSurface"));
      }
    }
```
(`USER`, `target`, `ADMIN`, `getSurface`, `DEFAULT_COMING_SOON_KEYS`, `isSurfaceHiddenError`, `check` already exist in that script.)

`scripts/smoke-outreach-guards.ts`: add `import { isSurfaceHiddenError, setSurfaceComingSoon } from "../src/lib/surface-visibility";`. Immediately after `await ensureUserSettings(USER);` insert:
```ts
  console.log("A coming-soon Outreach refuses its actions, even for an admin without the preview cookie");
  const closed = await sendOutreachMessageAction("00000000-0000-0000-0000-000000000000").then(
    () => null, (err: unknown) => err);
  check("send refuses while page.outreach is coming soon", isSurfaceHiddenError(closed), String(closed));
  // page.outreach ships coming soon and its actions now refuse; this PGlite is throwaway (smoke/_env).
  await setSurfaceComingSoon("smoke-outreach-admin", "page.outreach", false);
```
`scripts/smoke-batched-writes.ts` and `scripts/smoke-bounded-reads.ts`: import `setSurfaceComingSoon` and, after their `await ensureUserSettings(USER);`, add the comment and `await setSurfaceComingSoon("smoke-outreach-admin", "page.outreach", false);`.

- [ ] **Step 2: Run and confirm failure**

Run: `npx tsx scripts/smoke-surface-visibility.ts; npx tsx scripts/smoke-outreach-guards.ts`
Expected: first fails at `a coming-soon surface refuses its actions`; second fails at `send refuses while page.outreach is coming soon`.

- [ ] **Step 3: The guard (`src/lib/surface-visibility.ts`)**

After `requireVisibleSurface`:
```ts
/**
 * Throws `SurfaceHiddenError` unless `surfaceKey` is both switched on and released for
 * this viewer. `requireVisibleSurface` ignores `comingSoon` on purpose — the pages that use
 * it predate the flag — but a page that ships closed must close its actions too: a Server
 * Function answers a direct POST whether or not the nav shows the page.
 */
export async function requireReleasedSurface(userId: string, surfaceKey: string) {
  if (isAlwaysVisible(surfaceKey)) return;
  const { hidden, comingSoon } = await resolveSurfaceVisibility(userId);
  if (hidden.has(surfaceKey) || comingSoon.has(surfaceKey)) {
    throw new SurfaceHiddenError(surfaceKey);
  }
}
```
Keep this body identical to commit `bb7e79a3a` (leads stack) so the branches merge cleanly.

- [ ] **Step 4: Use it**

`src/lib/plan-guards.ts` line 3:
```ts
import { requireReleasedSurface, requireVisibleSurface } from "@/lib/surface-visibility";
```
In `requireOutreachUser`, replace `await requireVisibleSurface(userId, "page.outreach");` with `await requireReleasedSurface(userId, "page.outreach");`. Append:
```ts
/** `requireUserForSurface`, but a coming-soon page refuses too: for the actions of a page that ships closed. */
export async function requireUserForReleasedSurface(surfaceKey: string) {
  const userId = await requireUserId();
  await requireReleasedSurface(userId, surfaceKey);
  return userId;
}
```
Actions:
```bash
sed -i '' 's/requireUserForSurface/requireUserForReleasedSurface/g' src/actions/radar.ts
sed -i '' 's/requireUserForSurface(SURFACE)/requireUserForReleasedSurface(SURFACE)/g; s/import { requireSyncUser, requireUserForSurface } from "@\/lib\/plan-guards";/import { requireSyncUser, requireUserForReleasedSurface } from "@\/lib\/plan-guards";\nimport { requireReleasedSurface } from "@\/lib\/surface-visibility";/' src/actions/events.ts
grep -c "requireUserForSurface" src/actions/radar.ts src/actions/events.ts
```
Expected grep output: `0` for both files. Update the doc comment near the top of `src/actions/radar.ts` that names the old guard.

In `src/actions/events.ts`, inside each of `connectLuma`, `connectEventFeed`, `setGmailEventScan`, `startEventbriteOAuth`, after `const userId = await requireSyncUser();` add:
```ts
  await requireReleasedSurface(userId, SURFACE);
```
Leave `disconnectEventProvider` and `consumeEventbriteOAuthState` unchanged.

Optional: add `"requireUserForReleasedSurface",` to `SESSION_DERIVING` in `scripts/smoke-action-user-scope.ts`.

- [ ] **Step 5: Run and confirm**

Run: `npx tsx scripts/smoke-surface-visibility.ts && npx tsx scripts/smoke-outreach-guards.ts && npx tsx scripts/smoke-batched-writes.ts && npx tsx scripts/smoke-bounded-reads.ts && npx tsx scripts/smoke-action-user-scope.ts && npx tsx scripts/smoke-radar-run.ts && npx tsc --noEmit -p .`
Expected: all ok. Any other smoke that calls a radar/events action as `demo-user` will now see `SurfaceHiddenError`; release the surface in that script the same way (`npm test` in Task 15 will surface them).

- [ ] **Step 6: Commit**

```bash
git add src/lib/surface-visibility.ts src/lib/plan-guards.ts src/actions/radar.ts src/actions/events.ts scripts/smoke-surface-visibility.ts scripts/smoke-outreach-guards.ts scripts/smoke-batched-writes.ts scripts/smoke-bounded-reads.ts scripts/smoke-action-user-scope.ts
git commit -m "Surfaces: a coming-soon page refuses its server actions

Radar, Events and Outreach actions checked only the hidden set, so they
ran by direct POST while their pages showed coming soon.
requireReleasedSurface matches the guard on the leads stack.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Outreach never sends a delivered message twice (E2)

**Files:**
- Modify: `src/lib/outreach-quality.ts` (after line 29)
- Modify: `src/actions/outreach.ts` (imports; `sendOutreachMessageNow` after the demo-prospect block; `bulkSendOutreach` `inCampaign`; `markMessageAction` after "Message not found")
- Modify: `src/components/outreach/prospect-table.tsx`, `src/components/outreach/campaign-workspace.tsx`
- Test: `scripts/smoke-outreach-guards.ts`

**Interfaces:**
- Consumes: the Outreach release line in `smoke-outreach-guards.ts` (Task 6).
- Produces: `ALREADY_SENT_MESSAGE`.

- [ ] **Step 1: Write the failing checks**

In `scripts/smoke-outreach-guards.ts` add `markMessageAction` to the `../src/actions/outreach` import, plus `import { ALREADY_SENT_MESSAGE } from "../src/lib/outreach-quality";` and `import { isDeliveredMessage } from "../src/lib/outreach-metrics";`. Before the section that logs "Replies go to the sender" insert:
```ts
  console.log("\nA delivered message is never sent twice");
  check("a copied row with a sentAt counts as delivered",
    isDeliveredMessage({ id: "x", status: "copied", outcome: null, sentAt: new Date() }));
  const delivered = await seedProspectWithMessage(campaign.id, {
    externalId: "delivered-1",
    fullName: "Dana Delivered",
    email: "dana@delivered.example.org",
    status: "contacted",
    enrichment: {},
  });
  const sentAt = new Date("2026-01-01T00:00:00Z");
  await db.update(outreachMessages).set({ status: "sent", sentAt }).where(eq(outreachMessages.id, delivered.message.id));
  const resend = await sendOutreachMessageAction(delivered.message.id).catch((err: unknown) => ({
    ok: false as const, error: `threw: ${String(err)}`,
  }));
  check("the single send refuses an already-sent message",
    resend.ok === false && resend.error === ALREADY_SENT_MESSAGE, JSON.stringify(resend));
  const bulkResend = await outsideRequest(
    bulkSendOutreach({ campaignId: campaign.id, messageIds: [delivered.message.id], ignoreWarnings: true }));
  check("bulk send skips it: neither sent nor failed",
    bulkResend?.status === "sent" && bulkResend.sent === 0 && bulkResend.failed === 0, JSON.stringify(bulkResend));
  await outsideRequest(markMessageAction({ messageId: delivered.message.id, status: "copied" }));
  const afterResend = await db.query.outreachMessages.findFirst({ where: eq(outreachMessages.id, delivered.message.id) });
  check("…and copy never walks it back from sent",
    afterResend?.status === "sent" && afterResend.sentAt?.getTime() === sentAt.getTime(),
    `${afterResend?.status} ${afterResend?.sentAt?.toISOString()}`);
```
`seedProspectWithMessage`, `campaign`, `db`, `outsideRequest` exist in that script; adapt the seeder call to its real signature if it differs.

- [ ] **Step 2: Run and confirm failure**

Run: `npx tsx scripts/smoke-outreach-guards.ts`
Expected: FAIL at `the single send refuses an already-sent message`.

- [ ] **Step 3: Server guard**

`src/lib/outreach-quality.ts`:
```ts
export const ALREADY_SENT_MESSAGE = "This message was already sent, so Orbit won’t send it again";
```
`src/actions/outreach.ts`: import `isDeliveredMessage` (from `@/lib/outreach-metrics`) and `ALREADY_SENT_MESSAGE` (from `@/lib/outreach-quality`) on their existing import lines; confirm `UserFacingError` is imported.

In `sendOutreachMessageNow`, after the demo-prospect block and before its `try`:
```ts
  // A delivered message is never sent twice. The bulk bar and a stale tab can both still
  // point at one. Outside the try below: a refusal is not a failed send.
  // ponytail: check-then-send, so two concurrent sends can still both pass; a conditional
  // UPDATE claiming the row only while it is undelivered is the upgrade.
  if (isDeliveredMessage(message)) {
    throw new UserFacingError(ALREADY_SENT_MESSAGE);
  }
```
In `bulkSendOutreach`:
```ts
  const inCampaign = new Set(
    (await campaignMessages(input.campaignId, input.messageIds))
      .filter((m) => !isDeliveredMessage(m))
      .map((m) => m.id)
  );
```
In `markMessageAction`, after the `"Message not found"` check:
```ts
  // Copying or reopening a delivered message must not walk it back from "sent", or log its
  // interaction and schedule its follow-up a second time.
  if (isDeliveredMessage(message)) return null;
```

- [ ] **Step 4: Client rows**

`src/components/outreach/prospect-table.tsx`: `ProspectRow.message` gains `sentAt?: Date | string | null;` after `scheduledFor?`; the `isAwaitingReply({...})` and `isDeliveredMessage({...})` calls pass `sentAt: message.sentAt ?? null,`.

`src/components/outreach/campaign-workspace.tsx`: import `{ isDeliveredMessage, prospectPipelineBucket }` from `@/lib/outreach-metrics`; add `sentAt: active.sentAt ?? null,` after `scheduledFor:` in the `message:` object; change the `bulkRows` filter to
```ts
    .filter((p) => p.message && !isDeliveredMessage({ ...p.message, outcome: p.message.outcome ?? null }))
```

- [ ] **Step 5: Run and confirm**

Run: `npx tsx scripts/smoke-outreach-guards.ts && npx tsx scripts/smoke-outreach-readiness.ts && npx tsc --noEmit -p .`
Expected: all ok.

- [ ] **Step 6: Commit**

```bash
git add src/lib/outreach-quality.ts src/actions/outreach.ts src/components/outreach/prospect-table.tsx src/components/outreach/campaign-workspace.tsx scripts/smoke-outreach-guards.ts
git commit -m "Outreach: a delivered message is never sent twice

Bulk send re-sent sent-but-unanswered rows and Copy walked them back to
copied. The server refuses or skips delivered messages; the bulk bar no
longer offers them.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: A new drop never lands on an import queue that is still working (I1)

**Files:**
- Modify: `src/lib/imports/import-queue.ts` (after `isTerminal` ~158)
- Modify: `src/lib/imports/use-import-queue.ts` (imports ~25-34; state type ~82; `stageDrop` ~212-286)
- Modify: `src/lib/imports/import-copy.ts` (after `driveWaitForQueue` ~36)
- Modify: `src/components/imports/import-hub.tsx` (import ~52; `handleFiles` ~438; `<ImportDropzone>` ~632)
- Test: `scripts/smoke-import-queue.ts` (pure, registered)

**Interfaces:**
- Produces: `type QueuePhase`, `acceptsNewDrop(phase): boolean`, `stageDrop(result): Promise<boolean>`, `IMPORT_COPY.queueBusy`.

- [ ] **Step 1: Write the failing checks**

In `scripts/smoke-import-queue.ts` add `acceptsNewDrop` to the import-queue import. Before the final `if (failures) {` add:
```ts
console.log("A new drop never lands on a queue that is still working");
for (const phase of ["idle", "review", "done"] as const) {
  check(`a drop is staged while ${phase}`, acceptsNewDrop(phase));
}
for (const phase of ["previewing", "running"] as const) {
  check(`a drop is refused while ${phase}`, !acceptsNewDrop(phase));
}
// Why: ids repeat across drops, so the running loop cannot tell the old rows from the new.
const firstDrop = queueFromDetection([detected("linkedin_connections", "A.csv")]);
const secondDrop = reviewed(queueFromDetection([detected("linkedin_connections", "B.csv")]));
check("ids repeat across drops", firstDrop[0]!.id === secondDrop[0]!.id);
check("…so an unguarded run would import the new drop's rows unasked",
  nextRunnable(secondDrop)?.fileName === "B.csv");
```
(Use the script's real helper names for `detected`/`reviewed` if they differ.)

- [ ] **Step 2: Run and confirm failure**

Run: `npx tsx scripts/smoke-import-queue.ts`
Expected: FAIL — `acceptsNewDrop is not a function`.

- [ ] **Step 3: Implement**

`src/lib/imports/import-queue.ts`, after `isTerminal`:
```ts
export type QueuePhase = "idle" | "previewing" | "review" | "running" | "done";

/**
 * Whether a new drop may replace the queue. Never while previews or the run are in flight:
 * both write into the queue by id, and ids repeat across drops (`q0-linkedin_connections`),
 * so the old loops would preview, advance and import the new drop's rows. A queue in review
 * has nothing in flight — and re-dropping is the only way out of review — so it stays open.
 */
export function acceptsNewDrop(phase: QueuePhase): boolean {
  return phase !== "previewing" && phase !== "running";
}
```
`src/lib/imports/import-copy.ts`, in `IMPORT_COPY` after `driveWaitForQueue`:
```ts
  queueBusy: "One drop at a time — let the files above finish first",
```
`src/lib/imports/use-import-queue.ts`: add `acceptsNewDrop` and `type QueuePhase` to the import-queue import; import `IMPORT_COPY` and the same `toast` module the hub uses if absent; the state's `phase` field becomes `phase: QueuePhase;`. `stageDrop`:
```ts
export async function stageDrop(result: DetectionResult): Promise<boolean> {
  // Synchronous, before any await: two drops racing through detection both reach here, and
  // only the first may stage. See `acceptsNewDrop`.
  if (!acceptsNewDrop(state.phase)) {
    toast.message(IMPORT_COPY.queueBusy);
    return false;
  }
```
then the existing body, with the bare `return;` after `if (!items.length)` changed to `return true;` and a final `return true;` added.

`src/components/imports/import-hub.tsx`: import `getImportQueueState` alongside `stageDrop, useImportQueue` (export it from `use-import-queue.ts` returning the module `state` if it is not exported); `import { acceptsNewDrop } from "@/lib/imports/import-queue";`. First lines of `handleFiles`' body:
```ts
      // Also checked in `stageDrop`; here so a LinkedIn ZIP isn't read for seconds only to be refused.
      if (!acceptsNewDrop(getImportQueueState().phase)) {
        toast.message(IMPORT_COPY.queueBusy);
        return;
      }
```
On `<ImportDropzone ...>` add `disabled={!acceptsNewDrop(queue.phase)}`; if the component has no `disabled` prop, add one that disables its two buttons. Do not disable `useWindowFileDrop`/`useWindowFilePaste` (they also carry LinkedIn-link text).

- [ ] **Step 4: Run and confirm**

Run: `npx tsx scripts/smoke-import-queue.ts && npx tsx scripts/smoke-import-errors.ts && npx tsc --noEmit -p .`
Expected: all ok (`smoke-import-errors` checks the new copy's voice).

- [ ] **Step 5: Commit**

```bash
git add src/lib/imports src/components/imports scripts/smoke-import-queue.ts
git commit -m "Imports: a new drop never replaces a queue that is still working

A drop while previewing or running replaced the queue and the running
loop then imported the new files unasked. Review stays replaceable.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Clearing an AI key asks first and says when search will re-index (I3)

**Files:**
- Modify: `src/lib/ai-settings-write.ts` (append)
- Modify: `src/actions/settings.ts` (line 46 in place; getSettings providers map; `clearApiKey` patch ternary ~276-283 and embedding block ~293-304)
- Modify: `scripts/smoke-provider-exhaustive.ts` (drop stale `settings.ts:277/279/281` keys)
- Modify: `src/components/settings/provider-card.tsx`, `src/components/settings/ai-settings.tsx` (line 26 in place; Clear button ~363-376)
- Test: `scripts/smoke-clear-api-key.ts` (pglite, registered)

**Interfaces:**
- Produces: `clearedKeyPatch(provider)`, `clearMovesEmbeddings(provider, settings, eligibility): boolean`, provider status `clearResetsSearch: boolean`, `ClearKeyButton`.

- [ ] **Step 1: Write the failing checks**

In `scripts/smoke-clear-api-key.ts` import `clearMovesEmbeddings` from `../src/lib/ai-settings-write` and `managedEligibilityFor` from wherever it is exported (`grep -rn "export async function managedEligibilityFor" src/lib`). Inside `run(async () => {`, after the first `await seed();` and before the first `clearApiKey("openai")`:
```ts
  const seeded = (await (await getDb()).query.userSettings.findFirst({ where: eq(userSettings.userId, USER) }))!;
  const eligibility = await managedEligibilityFor(USER);
  check("Settings warns before clearing OpenAI — it moves search", clearMovesEmbeddings("openai", seeded, eligibility) === true);
  check("…and not before clearing Anthropic, which never embeds", clearMovesEmbeddings("anthropic", seeded, eligibility) === false);
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx tsx scripts/smoke-clear-api-key.ts`
Expected: FAIL — missing export.

- [ ] **Step 3: Shared prediction (append to `src/lib/ai-settings-write.ts`)**

```ts
/** Each provider's key column — a Record over AiProvider, so a new provider fails to compile here. */
const KEY_COLUMN = {
  gemini: "geminiApiKeyEncrypted",
  openai: "openaiApiKeyEncrypted",
  anthropic: "anthropicApiKeyEncrypted",
  openrouter: "openrouterApiKeyEncrypted",
} as const satisfies Record<AiProvider, string>;
type KeyColumn = (typeof KEY_COLUMN)[AiProvider];

/** The `user_settings` patch that clears one provider's key. */
export function clearedKeyPatch(provider: AiProvider): Partial<Record<KeyColumn, null>> {
  const patch: Partial<Record<KeyColumn, null>> = {};
  patch[KEY_COLUMN[provider]] = null;
  return patch;
}

/**
 * Whether clearing `provider`'s key moves search to another embedding backend — the rule
 * `clearApiKey` deletes vectors on, shared so Settings can warn before the click, not after.
 */
export function clearMovesEmbeddings(
  provider: AiProvider,
  settings: (Record<KeyColumn, string | null> & { aiProvider: string | null }) | null | undefined,
  eligibility: ManagedEligibility,
): boolean {
  if (!settings) return false;
  const selected = resolveAiProvider(settings.aiProvider);
  const before = embeddingBackendFor(selected, settings, eligibility);
  const after = embeddingBackendFor(selected, { ...settings, ...clearedKeyPatch(provider) }, eligibility);
  return Boolean(before && after && before !== after);
}
```
Add any missing names (`AiProvider`, `ManagedEligibility`, `resolveAiProvider`, `embeddingBackendFor`) to existing import lines at the top; if a new import line is unavoidable, re-run `smoke-provider-exhaustive` and update any shifted `ai-settings-write.ts` keys it reports.

- [ ] **Step 4: Use it in `clearApiKey` (`src/actions/settings.ts`)**

Line 46: replace `  embeddingBackendFor,` with `  clearedKeyPatch, clearMovesEmbeddings,` on the same line (keep `embeddingBackendFor` too if grep shows another use in this file).

In getSettings' providers map, after the `managedAvailable: …` line:
```ts
      /** Clearing this key moves search to another provider, which drops and rebuilds its index. */
      clearResetsSearch: clearMovesEmbeddings(p.id, settings, ai.eligibility),
```
(Use the real local names for the provider, the settings row and the eligibility at that site.)

Replace the patch ternary with `  const patch = clearedKeyPatch(active);` and the embedding block with:
```ts
  let embeddingReset = false;
  if (existing) {
    // Eligibility matters: on Lifetime, clearing a key can move search onto Orbit's managed key.
    embeddingReset = clearMovesEmbeddings(active, existing, await managedEligibilityFor(userId));
    if (embeddingReset) {
      await db.delete(contactEmbeddings).where(eq(contactEmbeddings.userId, userId));
    }
  }
```
In `scripts/smoke-provider-exhaustive.ts` delete the allowlist entries keyed `"src/actions/settings.ts:277"`, `":279"`, `":281"`. Run `npx tsx scripts/smoke-provider-exhaustive.ts`; if it reports moved `settings.ts:121/123/125` lines, update those keys to the numbers it prints.

- [ ] **Step 5: Two-step button (`src/components/settings/provider-card.tsx`)**

Import `useConfirmFocus` (`ls src/components/settings/use-confirm-focus.ts` to confirm the path). `ProviderCardStatus` gains `clearResetsSearch?: boolean;`. Add below `SAVE_THREW`:
```tsx
/** Clear a saved key in two steps — a clear can drop the account's search index. */
export function ClearKeyButton({
  label, resetsSearch, disabled, onConfirm, children, ...trigger
}: {
  label: string;
  resetsSearch: boolean;
  disabled: boolean;
  onConfirm: () => void;
  children: React.ReactNode;
} & Pick<React.ComponentProps<typeof Button>, "variant" | "aria-label" | "aria-describedby">) {
  const [confirming, setConfirming] = useState(false);
  const focus = useConfirmFocus(confirming ? "clear" : null);
  if (confirming) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span role="status" className="text-xs text-muted-foreground">
          {resetsSearch
            ? "Search moves to another provider and re-indexes your contacts"
            : `AI stops using your ${label} key`}
        </span>
        <Button ref={focus.confirmRef("clear")} type="button" size="sm" variant="destructive"
          disabled={disabled} onClick={() => { setConfirming(false); onConfirm(); }}>
          Clear key
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </span>
    );
  }
  return (
    <Button ref={focus.triggerRef("clear")} type="button" size="sm" disabled={disabled}
      {...trigger} onClick={() => setConfirming(true)}>
      {children}
    </Button>
  );
}
```
Read `use-confirm-focus.ts` and its caller in `api-settings.tsx` first; if the API differs from `useConfirmFocus(key | null) → { confirmRef(key), triggerRef(key) }`, follow the real one.

Replace the Clear key `<Button>` with:
```tsx
          <ClearKeyButton
            label={provider.label}
            resetsSearch={Boolean(status?.clearResetsSearch)}
            disabled={pending}
            variant="outline"
            aria-describedby={`provider-card-name-${provider.id}`}
            onConfirm={() => start(async () => { await onClear(provider.id); })}
          >
            Clear key
          </ClearKeyButton>
```

- [ ] **Step 6: Second Clear button (`src/components/settings/ai-settings.tsx`)**

Line 26, same line: `import { ClearKeyButton, ProviderCard, SAVE_THREW, TIER_LABELS } from "@/components/settings/provider-card";`. Replace the Clear `<Button>` with:
```tsx
                    <ClearKeyButton
                      label={p.label}
                      resetsSearch={p.clearResetsSearch}
                      disabled={pending}
                      variant="ghost"
                      aria-label={`Clear saved ${p.label} key`}
                      onConfirm={() => start(async () => { await clearKey(p.id); })}
                    >
                      Clear
                    </ClearKeyButton>
```

- [ ] **Step 7: Run and confirm**

Run: `npx tsx scripts/smoke-clear-api-key.ts && npx tsx scripts/smoke-provider-exhaustive.ts && npx tsx scripts/smoke-ai-providers.ts && npx tsc --noEmit -p .`
Expected: all ok.

- [ ] **Step 8: Commit**

```bash
git add src/lib/ai-settings-write.ts src/actions/settings.ts src/components/settings/provider-card.tsx src/components/settings/ai-settings.tsx scripts/smoke-clear-api-key.ts scripts/smoke-provider-exhaustive.ts
git commit -m "Settings: clearing an AI key asks first and says when search re-indexes

One click used to clear the key and drop every contact embedding. The
confirm uses the same prediction the action does.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Social links are stored as https links or refused by name (I7)

**Files:**
- Modify: `src/lib/safe-links.ts` (one `import type` at top; append)
- Modify: `src/actions/settings.ts` (`saveSocialLinks`, import)
- Modify: `src/components/settings/profile-settings.tsx` (Save socials handler)
- Modify: `src/components/graph/contact-inspect-panel.tsx` (import ~31; `socials` ~207)
- Test: Create `scripts/smoke-social-links.ts` (pure); register

**Interfaces:**
- Produces: `safeProfileUrl(value): string | null`, `normalizeSocialLinks(input)`, and `saveSocialLinks` returning `{ ok: true; links } | { ok: false; error }`.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-social-links.ts`:
```ts
/**
 * The socials a person saves become links on the sun's inspect panel, so they are stored as
 * https links or refused by name — never as whatever was typed.
 *
 * Pure tier: no database, no DOM. Run: npx tsx scripts/smoke-social-links.ts
 */
import { normalizeSocialLinks, safeProfileUrl } from "../src/lib/safe-links";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

console.log("Stored as https links");
const good = normalizeSocialLinks({ linkedin: " linkedin.com/in/ada ", twitter: "https://x.com/ada", github: "", website: "www.ada.dev" });
check("a bare LinkedIn path gains https", good.ok && good.links.linkedin === "https://linkedin.com/in/ada", JSON.stringify(good));
check("a full link is kept", good.ok && good.links.twitter === "https://x.com/ada");
check("an empty field is dropped", good.ok && !("github" in good.links));
check("a bare host gains https", good.ok && good.links.website === "https://www.ada.dev/");

console.log("Refused, naming the field");
const js = normalizeSocialLinks({ website: "javascript:alert(document.cookie)" });
check("a script scheme is refused", !js.ok && js.error.includes("Personal site"), JSON.stringify(js));
const data = normalizeSocialLinks({ github: "data:text/html,<b>x</b>" });
check("a data: link is refused", !data.ok && data.error.includes("GitHub"), JSON.stringify(data));
const handle = normalizeSocialLinks({ twitter: "@ada" });
check("a bare handle is refused, not stored as https://ada/", !handle.ok && handle.error.includes("X / Twitter"), JSON.stringify(handle));
check("credentials in the link are refused", !normalizeSocialLinks({ linkedin: "https://u:pw@linkedin.com/in/ada" }).ok);
check("a non-string value is refused, not thrown on", !normalizeSocialLinks({ website: { toString: () => "javascript:x" } }).ok);
for (const r of [js, handle]) {
  check("house voice", !r.ok && !r.error.endsWith(".") && !r.error.includes("'") && (r.error.match(/ — /g) ?? []).length <= 1, String(!r.ok && r.error));
}

console.log("Render guard for values stored before this");
check("a legacy script scheme renders as nothing", safeProfileUrl("javascript:alert(1)") === null);
check("a legacy handle renders as nothing", safeProfileUrl("ada") === null);
check("a legacy bare path renders as its https link", safeProfileUrl("github.com/ada") === "https://github.com/ada");

if (failures) {
  console.error(`\n${failures} social-link check${failures === 1 ? "" : "s"} failed`);
  process.exit(1);
}
console.log("\nsocial link smoke tests passed");
process.exit(0);
```
Register in the pure block: `  "smoke-social-links": "pure",`.

- [ ] **Step 2: Run and confirm failure**

Run: `npx tsx scripts/smoke-social-links.ts`
Expected: FAIL — `normalizeSocialLinks is not a function`.

- [ ] **Step 3: Implement (`src/lib/safe-links.ts`)**

Top: `import type { UserSocialLinks } from "@/lib/graph-data";` (confirm the type's home with `grep -rn "export type UserSocialLinks" src/lib`). Append:
```ts
/**
 * A link to someone's profile or site: `safeHttpUrl`, plus a host with a dot in it. Without the
 * dot check a handle typed into a URL field — `@ada`, `ada` — becomes `https://ada/`.
 */
export function safeProfileUrl(value: string | null | undefined): string | null {
  const url = safeHttpUrl(value);
  return url && new URL(url).hostname.includes(".") ? url : null;
}

const SOCIAL_FIELDS = {
  linkedin: "LinkedIn",
  twitter: "X / Twitter",
  github: "GitHub",
  website: "Personal site",
} as const satisfies Record<keyof UserSocialLinks, string>;

/** The socials a person saves, as https links — or the first field that is not one, by name. */
export function normalizeSocialLinks(
  input: Partial<Record<keyof UserSocialLinks, unknown>>,
): { ok: true; links: UserSocialLinks } | { ok: false; error: string } {
  const links: UserSocialLinks = {};
  for (const key of Object.keys(SOCIAL_FIELDS) as (keyof UserSocialLinks)[]) {
    const raw = String(input[key] ?? "").trim();
    if (!raw) continue;
    const url = safeProfileUrl(raw);
    if (!url) {
      return { ok: false, error: `That ${SOCIAL_FIELDS[key]} link doesn’t look like a web address — paste the whole link` };
    }
    links[key] = url;
  }
  return { ok: true, links };
}
```

- [ ] **Step 4: Action and UIs**

`src/actions/settings.ts`: import `normalizeSocialLinks` (prefer appending to an existing import line above line 121; if a new line shifts 121/123/125, update those keys in `smoke-provider-exhaustive.ts`). Replace `saveSocialLinks`:
```ts
export async function saveSocialLinks(input: {
  linkedin?: string;
  twitter?: string;
  github?: string;
  website?: string;
}) {
  const userId = await requireUserId();
  // Checked here, not only in the field: the stored value becomes a link on the sun's
  // inspect panel, and a Server Action is reachable without this form.
  const normalized = normalizeSocialLinks(input);
  if (!normalized.ok) return normalized;
  const socialLinks = normalized.links;
  const db = await getDb();

  await db
    .insert(userSettings)
    .values({ userId, socialLinks })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: { socialLinks, updatedAt: new Date() },
    });

  revalidatePath("/settings");
  revalidatePath("/graph");
  return { ok: true as const, links: socialLinks };
}
```
Keep any revalidate calls the old body had.

`src/components/settings/profile-settings.tsx`, the Save socials `start(async () => { ... })` body:
```tsx
            start(async () => {
              try {
                const res = await saveSocialLinks(socials);
                if (!res.ok) {
                  toast.error(res.error);
                  return;
                }
                // Show what was stored: `linkedin.com/in/ada` comes back as its https link.
                setSocials({
                  linkedin: res.links.linkedin ?? "",
                  twitter: res.links.twitter ?? "",
                  github: res.links.github ?? "",
                  website: res.links.website ?? "",
                });
                toast.success("Social links saved");
              } catch (err) {
                toast.error(friendlyError(err, TOAST_COPY.saveFailed));
              }
            })
```
Import `friendlyError`/`TOAST_COPY` if absent.

`src/components/graph/contact-inspect-panel.tsx`: import `{ safeHttpUrl, safeProfileUrl }` from `@/lib/safe-links`; replace `const socials = summary.socialLinks || {};` with:
```ts
  // Values saved before saves were normalised can still be anything typed into the field.
  const stored = summary.socialLinks || {};
  const socials = {
    linkedin: safeProfileUrl(stored.linkedin),
    twitter: safeProfileUrl(stored.twitter),
    github: safeProfileUrl(stored.github),
    website: safeProfileUrl(stored.website),
  };
```

- [ ] **Step 5: Run and confirm**

Run: `npx tsx scripts/smoke-social-links.ts && npx tsx scripts/smoke-ai-guardrails.ts && npx tsx scripts/smoke-provider-exhaustive.ts && npx tsx scripts/run-smoke.ts --check && npx tsc --noEmit -p .`
Expected: all ok.

- [ ] **Step 6: Commit**

```bash
git add src/lib/safe-links.ts src/actions/settings.ts src/components/settings/profile-settings.tsx src/components/graph/contact-inspect-panel.tsx scripts/smoke-social-links.ts scripts/run-smoke.ts scripts/smoke-provider-exhaustive.ts
git commit -m "Settings: social links are stored as https links or refused by name

Values were stored as typed and rendered as links. The panel also guards
values saved before this change.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: An edited reminder title in the capture summary is what gets saved (K1)

**Files:**
- Modify: `src/lib/capture/types.ts` (~254)
- Modify: `src/lib/capture/review-reducer.ts` (after `defaultReminderKeys` ~180)
- Modify: `src/lib/capture-job-runner.ts` (review-reducer import ~30-39; title ~492)
- Modify: `src/components/capture/capture-summary.tsx` (import ~21; `suggestionsFromChoices`, `choicesFromSuggestions` ~25-48)
- Modify: `src/components/capture/suggested-reminders-review.tsx` (title input ~122-126)
- Test: `scripts/smoke-capture-review-reducer.ts` (pure), `scripts/smoke-capture-reminder-count.ts` (pglite)

**Interfaces:**
- Produces: `REMINDER_TITLE_MAX = 200`, `reminderTitleOverride(edited, parsed): string | undefined`, `CaptureReminderChoices.overrides[key].title?: string`.

- [ ] **Step 1: Write the failing checks**

`scripts/smoke-capture-review-reducer.ts`: add `reminderTitleOverride, REMINDER_TITLE_MAX` to the reducer import; append before the script's final summary:
```ts
check("an edited reminder title is trimmed", reminderTitleOverride("  Send the deck  ", "Follow up") === "Send the deck");
check("a blank edit keeps the parsed title", reminderTitleOverride("   ", "Follow up") === undefined);
check("editing back to the parsed title stores nothing", reminderTitleOverride("Follow up", "Follow up") === undefined);
check("an edited title is capped at the reminder-title limit", reminderTitleOverride("x".repeat(500), "Follow up")?.length === REMINDER_TITLE_MAX);
```
`scripts/smoke-capture-reminder-count.ts`: add `recordCaptureChoicesRow` to the `../src/lib/capture-jobs` import, `captureJobs` to the schema import if missing, and `import { choicesFromSuggestions, suggestionsFromChoices } from "../src/components/capture/capture-summary";`. Inside `try`, after the check `"the rows are the planned titles"`:
```ts
    console.log("\nAn edited reminder title is what gets saved…");
    await cleanup(); // also drops the batch, so findBatchForCorpus can't short-circuit the second save of NOTE
    await ensureUserSettings(USER);
    const edited = await createCaptureJob(USER, { sourceKind: "messy", status: "queued", inputText: NOTE });
    await runCaptureJobById(edited.id, deps);
    await recordCaptureDecisionRow(USER, edited.id, "0-Priya Raman", { decision: "accept", index: 0, mergeContactId: null, relationshipScore: 3, tagNames: [], decidedAt });
    const editedRow = (await getCaptureJobById(edited.id))!;
    const onScreen = suggestionsFromChoices(editedRow.result!, editedRow.decisions?.reminders).map((s) =>
      s.key === "0-next week" ? { ...s, title: "  Send Priya the PM deck  " } : s
    );
    const choices = choicesFromSuggestions(onScreen, editedRow.result!.suggestedReminders);
    check("the stored choices carry the edit, trimmed", choices.overrides["0-next week"]?.title === "Send Priya the PM deck", JSON.stringify(choices));
    check("a reload shows the edit", suggestionsFromChoices(editedRow.result!, choices).find((s) => s.key === "0-next week")?.title === "Send Priya the PM deck");
    check(
      "an untouched title stores nothing",
      choicesFromSuggestions(suggestionsFromChoices(editedRow.result!, undefined), editedRow.result!.suggestedReminders).overrides["0-next week"] === undefined
    );
    await recordCaptureChoicesRow(USER, edited.id, { reminders: choices });
    await db.update(captureJobs).set({ status: "saving", claimToken: null }).where(eq(captureJobs.id, edited.id));
    const editedSaved = await runCaptureJobById(edited.id, deps);
    check("the edited capture saves", editedSaved?.status === "saved", `${editedSaved?.status} ${editedSaved?.error}`);
    const editedTitles = (await db.query.reminders.findMany({ where: eq(reminders.userId, USER) })).map((r) => r.title);
    check("the reminder carries the edited title", editedTitles.includes("Send Priya the PM deck"), JSON.stringify(editedTitles));
    check("  not the parsed one", !editedTitles.includes("Follow up with Priya about the PM role"), JSON.stringify(editedTitles));
```
Use the script's real names for `NOTE`, `cleanup`, `decidedAt`, `db`, the reminder key (`"0-next week"`) and the parsed title; read its first section to confirm them.

- [ ] **Step 2: Run and confirm failure**

Run: `npx tsx scripts/smoke-capture-review-reducer.ts; npx tsx scripts/smoke-capture-reminder-count.ts`
Expected: both FAIL (missing export; then the override is undefined).

- [ ] **Step 3: Implement**

`src/lib/capture/types.ts`:
```ts
  overrides: Record<string, { personName?: string | null; dueDateIso?: string; title?: string }>;
```
`src/lib/capture/review-reducer.ts`, after `defaultReminderKeys`:
```ts
/** The same cap as every other reminder-title boundary (`tools/definitions.ts`, `api/schemas.ts`). */
export const REMINDER_TITLE_MAX = 200;

/**
 * An edited dated-commitment title, as the summary stores it and the runner saves it:
 * trimmed and capped. Blank, or unchanged from the parsed title, means "no override".
 * The runner applies it too, because `decisions` is client-written JSON nothing validates.
 */
export function reminderTitleOverride(edited: string | null | undefined, parsed: string): string | undefined {
  const t = edited?.trim().slice(0, REMINDER_TITLE_MAX);
  return t && t !== parsed ? t : undefined;
}
```
`src/lib/capture-job-runner.ts`: import `reminderTitleOverride`; change `title: s.title,` in the commitments map to:
```ts
          title: reminderTitleOverride(o.title, s.title) ?? s.title,
```
`src/components/capture/capture-summary.tsx`: import `reminderTitleOverride`; replace the two functions:
```ts
export function suggestionsFromChoices(result: CaptureJobResult, choices: CaptureReminderChoices | undefined): SuggestionReviewItem[] {
  const checked = new Set(choices?.checked ?? defaultReminderKeys(result.suggestedReminders));
  return result.suggestedReminders.map((s) => {
    const o = choices?.overrides?.[s.key];
    return {
      ...s,
      title: o?.title ?? s.title,
      dueDateIso: o?.dueDateIso ?? s.dueDateIso,
      checked: checked.has(s.key),
      personNameOverride: o?.personName === undefined ? null : o.personName,
    };
  });
}

export function choicesFromSuggestions(items: SuggestionReviewItem[], base: readonly { key: string; dueDateIso: string; title: string }[]): CaptureReminderChoices {
  const overrides: CaptureReminderChoices["overrides"] = {};
  for (const it of items) {
    const original = base.find((b) => b.key === it.key);
    const o: { personName?: string | null; dueDateIso?: string; title?: string } = {};
    if (it.personNameOverride !== null) o.personName = it.personNameOverride;
    if (original && it.dueDateIso !== original.dueDateIso) o.dueDateIso = it.dueDateIso;
    const title = original ? reminderTitleOverride(it.title, original.title) : undefined;
    if (title) o.title = title;
    if (Object.keys(o).length) overrides[it.key] = o;
  }
  return { checked: items.filter((i) => i.checked).map((i) => i.key), overrides };
}
```
Diff against the current bodies first; keep any field the current `suggestionsFromChoices` returns that is not shown.
`src/components/capture/suggested-reminders-review.tsx`: import `REMINDER_TITLE_MAX` from `@/lib/capture/review-reducer` and add `maxLength={REMINDER_TITLE_MAX}` to the title `<Input>`.

- [ ] **Step 4: Run and confirm**

Run: `npx tsx scripts/smoke-capture-review-reducer.ts && npx tsx scripts/smoke-capture-reminder-count.ts && npx tsx scripts/smoke-capture-jobs.ts && npx tsc --noEmit -p .`
Expected: all ok.

- [ ] **Step 5: Commit**

```bash
git add src/lib/capture src/lib/capture-job-runner.ts src/components/capture/capture-summary.tsx src/components/capture/suggested-reminders-review.tsx scripts/smoke-capture-review-reducer.ts scripts/smoke-capture-reminder-count.ts
git commit -m "Capture: an edited reminder title is what gets saved

The summary's title field changed local state only; the stored choices
had no title, so the parsed title was saved.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: A failed extraction gives the notes back and can be retried (K2)

**Files:**
- Modify: `src/lib/capture/review-reducer.ts` (after `initialPhaseFor` ~147)
- Modify: `src/components/capture/capture-flow.tsx` (import ~45; initial mode ~127-129; prefill ~225-226; new `retryExtraction` after `stopExtraction` ~376; banner ~455-462)
- Test: `scripts/smoke-capture-review-reducer.ts` (pure), `scripts/smoke-capture-jobs.ts` (pglite)

**Interfaces:**
- Consumes: nothing from Task 11 except the shared reducer file.
- Produces: `captureJobText(job): string`, `prefillJobFor(job): J | null`.

- [ ] **Step 1: Write the failing checks**

`scripts/smoke-capture-review-reducer.ts`: add `captureJobText, prefillJobFor` to the reducer import and `CaptureJobStatus` to the types import. Append (the file already defines `result`):
```ts
const failedView = (over: { status?: CaptureJobStatus; result?: typeof result | null; inputText?: string | null; blocks?: { text: string }[] } = {}) =>
  ({ status: "failed" as CaptureJobStatus, result: null, inputText: "Met Priya at the dinner.", blocks: [], ...over });
check("an extraction failure gives its notes back", prefillJobFor(failedView())?.inputText === "Met Priya at the dinner.");
check("a transcript waiting for Extract is prefilled", prefillJobFor(failedView({ status: "transcribed" })) !== null);
check("a SAVE failure is not prefilled (its notes were read)", prefillJobFor(failedView({ result })) === null);
check("a failure with nothing to give back is not prefilled", prefillJobFor(failedView({ inputText: null })) === null);
check("a failure that holds only blocks is prefilled", prefillJobFor(failedView({ inputText: null, blocks: [{ text: "voice memo" }] })) !== null);
for (const status of ["queued", "extracting", "ready", "reviewing", "saving", "saved", "discarded", "ingesting"] as const) {
  check(`${status} is not prefilled`, prefillJobFor(failedView({ status })) === null);
}
check("the box text joins typed text and blocks", captureJobText({ inputText: "typed", blocks: [{ text: "voice" }] }) === "typed\n\n---\n\nvoice");
check("no prefill for no job", prefillJobFor(null) === null);
```
`scripts/smoke-capture-jobs.ts`: between the checks `"a recently failed job is still surfaced to the page"` and `"discarding it works"` insert:
```ts
  const failed = await getCaptureJobById(broken.id);
  check("an extraction failure keeps the notes on the row and has no result", failed?.inputText === "x" && failed?.result === null);
  const retried = await queueCaptureJobRow(USER, broken.id, { inputText: "x" });
  check("Try again re-queues the same failed row, error cleared", retried?.id === broken.id && retried.status === "queued" && retried.error === null && retried.inputText === "x");
```
(Skip the `const failed` line if a variable with the failed row already exists there; import `getCaptureJobById` if needed.)

- [ ] **Step 2: Run and confirm failure**

Run: `npx tsx scripts/smoke-capture-review-reducer.ts`
Expected: FAIL — missing exports. Then run `npx tsx scripts/smoke-capture-jobs.ts`: its new checks are a regression guard for the server path and pass today.

- [ ] **Step 3: Pure rule (`src/lib/capture/review-reducer.ts`)**

After `initialPhaseFor`:
```ts
/** The text a job's notes box shows: the typed text, then every transcribed block. */
export function captureJobText(job: { inputText: string | null; blocks: readonly { text: string }[] }): string {
  return [job.inputText, ...job.blocks.map((b) => b.text)].filter(Boolean).join("\n\n---\n\n");
}

/**
 * The job whose notes go back in the box on load: a transcript waiting for Extract, or an
 * EXTRACTION that failed (no result) — the draft was cleared when it queued, so the row is
 * the only copy. A SAVE failure has a result; its notes were read and "Try saving again" is
 * the way on. A failure with no text is not prefilled: an empty box holding a job id
 * discards that job (`useCaptureIngest`), which would take the error banner with it.
 */
export function prefillJobFor<J extends { status: CaptureJobStatus; result: unknown; inputText: string | null; blocks: readonly { text: string }[] }>(
  job: J | null
): J | null {
  if (!job) return null;
  if (job.status === "transcribed") return job;
  return job.status === "failed" && !job.result && captureJobText(job).trim() ? job : null;
}
```

- [ ] **Step 4: Wire the flow (`src/components/capture/capture-flow.tsx`)**

Import `captureJobText, prefillJobFor` from the reducer. Initial tab:
```ts
  const [mode, setMode] = useState<CaptureMode>(() =>
    initialJob && (initialJob.status === "ingesting" || prefillJobFor(initialJob)) ? tabForSource(initialJob.sourceKind) : defaultMode
  );
```
Prefill:
```ts
  const prefill = prefillJobFor(initialJob);
  const prefillText = prefill ? captureJobText(prefill) : "";
```
After `stopExtraction`:
```ts
  /**
   * Try again on an extraction failure: re-queue the SAME row (`queueCaptureJobRow` accepts
   * `failed`) with what is in the box now — or, when the box is empty (a meeting, or a
   * failure seen from another tab), the text the job still holds. Never empty: the action
   * writes `text || null` over `input_text`.
   */
  const retryExtraction = useCallback(() => {
    if (!job || job.result) return;
    const ingest = job.sourceKind === "voice" ? voice : messy;
    const fromBox = Boolean(ingest.notes.trim());
    void startExtraction({
      text: fromBox ? ingest.notes : captureJobText(job),
      hints: fromBox ? ingest.hints : null, // null keeps the row's stored hints
      jobId: job.id,
      sourceKind: job.sourceKind,
      meetingSessionId: job.meetingSessionId,
      mentionPicks: fromBox ? ingest.mentionPicks : job.mentionPicks,
    });
  }, [job, messy, voice, startExtraction]);
```
Read `startExtraction`'s parameter type first and pass exactly the fields it declares (tsc will flag extras). Failure banner buttons:
```tsx
            {job.result ? (
              <button type="button" className="font-medium text-primary hover:underline" onClick={() => void save(job.id)}>
                Try saving again
              </button>
            ) : (
              <button type="button" className="font-medium text-primary hover:underline" onClick={retryExtraction}>
                Try again
              </button>
            )}
            {/* An extraction failure dismisses like Stop: the job goes, the notes stay. */}
            <button type="button" className="font-medium text-muted-foreground hover:underline" onClick={job.result ? () => void startOver() : stopExtraction}>
              Dismiss
            </button>
```

- [ ] **Step 5: Run and confirm**

Run: `npx tsx scripts/smoke-capture-review-reducer.ts && npx tsx scripts/smoke-capture-jobs.ts && npx tsc --noEmit -p .`
Expected: all ok.

- [ ] **Step 6: Commit**

```bash
git add src/lib/capture/review-reducer.ts src/components/capture/capture-flow.tsx scripts/smoke-capture-review-reducer.ts scripts/smoke-capture-jobs.ts
git commit -m "Capture: a failed extraction gives the notes back and can be retried

The draft is cleared when a job queues, so after a failed extraction and
a reload the box was empty and Dismiss deleted the only copy.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Chat history is locked while an answer streams; Stop leaves no orphan question (H1, H2, H5)

**Files:**
- Create: `src/lib/chat-answer-landed.ts`
- Modify: `src/components/chat/chat-history-rail.tsx` (row ~172-179; delete ~193-198)
- Modify: `src/components/chat/chat-panel.tsx` (`removeThread` ~880; `onDone` ~1027-1040; phone history item ~1439; its delete ~1460; comment ~1059; copy ~2052)
- Modify: `src/app/api/chat/route.ts` (catch ~314-320)
- Test: Create `scripts/smoke-chat-answer-landed.ts` (pure); register

**Interfaces:**
- Produces: `headerTitleAfterAnswer(answeredThreadId, openThreadId, title): string | null`, `threadsAfterAnswer(prev, answeredThreadId, title, now): LandedThread[]`.

- [ ] **Step 1: Write the failing test**

Create `scripts/smoke-chat-answer-landed.ts`:
```ts
/**
 * A chat answer that lands must only touch the thread it answered, and the history controls
 * that could pull a thread out from under a live answer must be locked while one streams.
 *
 *   - `src/lib/chat-answer-landed.ts`: header title only for the open thread; the list update
 *     always applies to the answered thread.
 *   - Source guards (no jsdom here): every history row, phone history item and delete control
 *     is `disabled={busy}`; the chat route discards an unanswered question BEFORE the
 *     client-gone early return, so a Stop does not strand it.
 *
 * Pure: no network, no database. Run: npx tsx scripts/smoke-chat-answer-landed.ts
 */
import { readFileSync } from "node:fs";
import { headerTitleAfterAnswer, threadsAfterAnswer } from "../src/lib/chat-answer-landed";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

console.log("Header title...");
check("names the open thread", headerTitleAfterAnswer("a", "a", "Intro to Maya") === "Intro to Maya");
check("leaves another thread's header alone", headerTitleAfterAnswer("a", "b", "Intro to Maya") === null);
check("leaves a cleared (deleted/new) panel alone", headerTitleAfterAnswer("a", null, "Intro to Maya") === null);
check("no title, no change", headerTitleAfterAnswer("a", "a", null) === null && headerTitleAfterAnswer("a", "a", "") === null);

console.log("History list...");
{
  const old = new Date(2026, 0, 1);
  const now = new Date(2026, 9, 8, 12);
  const prev = [
    { id: "b", title: "B", createdAt: old, updatedAt: old },
    { id: "a", title: null, createdAt: old, updatedAt: old },
  ];
  const next = threadsAfterAnswer(prev, "a", "Intro to Maya", now);
  check("answered thread moves to the top, named", next[0].id === "a" && next[0].title === "Intro to Maya", JSON.stringify(next));
  check("no duplicate row", next.filter((t) => t.id === "a").length === 1 && next.length === 2);
  check("other rows keep their order", next[1].id === "b");
  check("updatedAt is now", next[0].updatedAt === now);
  check("a thread not yet listed (deep link) is added", threadsAfterAnswer(prev, "c", "C", now).length === 3);
  check("prev is not mutated", prev[1].title === null && prev.length === 2);
}

/** The opening tag of the `<tag` element that contains `marker` (props end at a lone `>` line). */
function openingTag(src: string, marker: string, tag: string): string {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  const start = src.lastIndexOf(`<${tag}`, at);
  const end = src.slice(start).search(/\n\s*>\s*\n/);
  if (start < 0 || end < 0) throw new Error(`no <${tag}> around: ${marker}`);
  return src.slice(start, start + end);
}
const lockedWhileBusy = (src: string, marker: string, tag: string) =>
  /\bdisabled=\{busy\}/.test(openingTag(src, marker, tag));

console.log("History controls locked while an answer streams...");
{
  const rail = readFileSync("src/components/chat/chat-history-rail.tsx", "utf8");
  const panel = readFileSync("src/components/chat/chat-panel.tsx", "utf8");
  check("rail row (the active one too)", lockedWhileBusy(rail, "onSelect(thread.id)", "button"));
  check("rail delete", lockedWhileBusy(rail, "onDelete(thread.id)", "button"));
  check("phone history item", lockedWhileBusy(panel, "void loadThread(thread.id, { prefetched: true });", "DropdownMenuItem"));
  check("phone history delete", lockedWhileBusy(panel, "removeThread(thread.id);", "button"));
}

console.log("Stop does not strand the question...");
{
  const route = readFileSync("src/app/api/chat/route.ts", "utf8");
  const discard = route.indexOf("await discardUnansweredQuestion(");
  const early = route.indexOf("if (request.signal.aborted) return;");
  check("discard runs before the client-gone return", discard >= 0 && early >= 0 && discard < early, `discard@${discard} early@${early}`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed.");
process.exit(0);
```
Register after `"smoke-chat-thread-prefetch": "pure",`: `  "smoke-chat-answer-landed": "pure",`.

- [ ] **Step 2: Run and confirm failure**

Run: `npx tsx scripts/smoke-chat-answer-landed.ts`
Expected: FAIL — cannot find module `../src/lib/chat-answer-landed`.

- [ ] **Step 3: Create `src/lib/chat-answer-landed.ts`**

```ts
/**
 * What a finished answer changes outside its own bubble (`sendQuestion`'s `onDone`).
 *
 * The thread it answered always moves to the top of the history under the name the server
 * settled on — even when the person has since moved to another thread, because the rail hides
 * an untitled thread that is not open, so skipping this would make that chat vanish.
 *
 * The header title is different: it names the thread ON SCREEN. An answer that outlived a
 * switch must not rename the conversation the person moved to.
 */
export type LandedThread = {
  id: string;
  title: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

/** The title to put in the header, or null to leave the header alone. */
export function headerTitleAfterAnswer(
  answeredThreadId: string,
  openThreadId: string | null,
  title: string | null | undefined
): string | null {
  return title && answeredThreadId === openThreadId ? title : null;
}

/** The history list with the answered thread first, named `title`. */
export function threadsAfterAnswer<T extends LandedThread>(
  prev: readonly T[],
  answeredThreadId: string,
  title: string | null | undefined,
  now: Date
): LandedThread[] {
  return [
    { id: answeredThreadId, title: title ?? null, createdAt: now, updatedAt: now },
    ...prev.filter((t) => t.id !== answeredThreadId),
  ];
}
```
Run the smoke: helper checks pass; the five source checks still fail.

- [ ] **Step 4: Lock the controls**

`src/components/chat/chat-history-rail.tsx`, row button: `disabled={busy && !active}` → `disabled={busy}`, and move the dim style to the inactive branch:
```tsx
                            disabled={busy}
                            aria-current={active ? "true" : undefined}
                            className={cn(
                              "w-full rounded-lg px-2 py-1.5 pr-7 text-left text-sm leading-snug transition-colors",
                              active
                                ? "bg-primary/10 font-medium text-primary"
                                : "text-foreground/80 hover:bg-muted disabled:opacity-50"
                            )}
```
Rail delete button: add `disabled={busy}` on its own line after `onClick={() => onDelete(thread.id)}` and append ` disabled:invisible` to its className.

`src/components/chat/chat-panel.tsx`: the phone history `<DropdownMenuItem ...>` gets `disabled={busy}` on its own line after `className`; its nested delete `<button>` gets `disabled={busy}` after `aria-label="Delete chat"` and ` disabled:invisible` appended to its className. Each opening tag must still end with a lone `>` line (the smoke reads up to it).

- [ ] **Step 5: Abort on delete, gate the header title**

`removeThread`: first statement inside the callback, before `start(`:
```ts
      // Deletes are locked while an answer streams; if one of the open thread gets through anyway,
      // end the answer FIRST. Left running it fails on the deleted thread (reported, question put
      // back) or lands and re-adds the row.
      if (threadId === id) abortRef.current?.abort();
```
`onDone`: keep `if (info.notice) toast.message(info.notice);`, then replace `if (info.title) setThreadTitle(info.title);` and the following `setThreads((prev) => { ... });` with:
```ts
              // The header names the thread ON SCREEN; the list update is about the answered
              // thread wherever the person is (see @/lib/chat-answer-landed).
              const headerTitle = headerTitleAfterAnswer(activeId, threadIdRef.current, info.title);
              if (headerTitle) setThreadTitle(headerTitle);
              const landedAt = new Date();
              setThreads((prev) => threadsAfterAnswer(prev, activeId, info.title, landedAt));
```
Add `import { headerTitleAfterAnswer, threadsAfterAnswer } from "@/lib/chat-answer-landed";`.

- [ ] **Step 6: Discard the unanswered question on Stop (`src/app/api/chat/route.ts`)**

First read `discardUnansweredQuestion` in `src/lib/chat-persist.ts`: confirm it deletes only when the given message is still the thread's last message and its role is `user`. If it does not, stop and report rather than proceed. Then in the stream's `catch (err)` put the discard first:
```ts
      } catch (err) {
        // The question was written before the model ran (it carries the attached people and,
        // on a regenerate, the slot). Nothing answered it — a failure or a Stop alike — so it
        // does not stay. Before the client-gone return: a Stop is exactly when it is gone.
        await discardUnansweredQuestion(userId, threadId, persistedUserMessageId).catch(() => {});
        // The client is gone: there is nobody to tell, and enqueueing now would throw. Not
        // an error of ours either — the provider call was aborted on purpose.
        if (request.signal.aborted) return;
```
Delete the original discard line further down in that catch. In `chat-panel.tsx` change the stopped-bubble copy `this answer wasn’t saved` to `this turn wasn’t saved`, and reword the nearby comment that says the question is kept.

- [ ] **Step 7: Run and confirm**

Run: `npx tsx scripts/smoke-chat-answer-landed.ts && npx tsx scripts/smoke-chat-thread-prefetch.ts && npx tsx scripts/run-smoke.ts --check && npx tsc --noEmit -p .`
Expected: all 15 checks ok; tsc 0.

- [ ] **Step 8: Commit**

```bash
git add src/lib/chat-answer-landed.ts src/components/chat/chat-history-rail.tsx src/components/chat/chat-panel.tsx src/app/api/chat/route.ts scripts/smoke-chat-answer-landed.ts scripts/run-smoke.ts
git commit -m "Chat: history is locked while an answer streams; Stop leaves no orphan question

Switching or deleting a thread mid-answer dropped the answer or renamed
the wrong thread. A stopped question was kept and fed back to the model.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: The floating bell never covers header actions; phone contact names get the row (U1, U2)

**Files:**
- Modify: `src/components/layout/app-shell.tsx` (~285-293)
- Modify: `src/app/globals.css` (delete the `data-clear-floating-controls` block ~3270-3278 and the `--orbit-top-rail` block ~380-397 if graph is its only user)
- Modify: every file with `data-clear-floating-controls` (`grep -rn "data-clear-floating-controls" src`), `src/app/(clerk)/(app)/(main)/graph/page.tsx` (~33)
- Modify: `src/components/contacts/contacts-list.tsx` (~794-836)
- Create: `scripts/dev/check-floating-rail.mjs` (manual browser check, not a smoke)

- [ ] **Step 1: Write the browser check**

Create `scripts/dev/check-floating-rail.mjs`:
```js
// Manual layout check: the bell/feedback rail never overlaps header actions, and phone
// contact rows give the name room. Needs a demo-mode dev server.
// Run: BASE=http://localhost:3001 node scripts/dev/check-floating-rail.mjs
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://localhost:3001";
const browser = await chromium.launch({
  executablePath: process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function rect(page, sel) {
  return page.evaluate((s) => {
    const el = [...document.querySelectorAll(s)].find((e) => e.getBoundingClientRect().width > 0);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width };
  }, sel);
}
const hit = (a, b) => a && b && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

for (const width of [1440, 1280]) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  await ctx.addCookies([{ name: "orbit_preview_unreleased", value: "1", domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  for (const [route, sel] of [
    ["/contacts", '[role="tablist"][aria-label="People view"]'],
    ["/contacts?sort=closeness", '[role="tablist"][aria-label="People view"]'],
    ["/recruiters", '[role="tablist"][aria-label="People view"]'],
    ["/outreach", 'a[href="/outreach/new"]'],
  ]) {
    await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(2500);
    const bell = await rect(page, 'div.fixed > button[aria-label^="Open notifications"]');
    const fb = await rect(page, 'div.fixed > button[aria-label="Send feedback"]');
    const action = await rect(page, sel);
    check(`${width} ${route}: header action found`, Boolean(action));
    check(`${width} ${route}: clear of the bell and feedback`, Boolean(action) && !hit(bell, action) && !hit(fb, action),
      JSON.stringify({ bell, fb, action }));
  }
  await ctx.close();
}

{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(BASE + "/contacts", { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(2500);
  const name = await rect(page, "li.contact-row p.truncate.font-medium");
  check("phone: contact name gets at least 150px", Boolean(name) && name.w >= 150, JSON.stringify(name));
  const del = await rect(page, 'li.contact-row button[aria-label^="Delete "]');
  check("phone: row delete button is hidden", del === null);
  await ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/contacts", { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(2500);
  const del = await rect(page, 'li.contact-row button[aria-label^="Delete "]');
  check("desktop: row delete button is still shown", del !== null);
  await ctx.close();
}

await browser.close();
process.exit(failures ? 1 : 0);
```
If `playwright` does not resolve as a bare import, use `./node_modules/playwright/index.mjs`. If `li.contact-row` or `p.truncate.font-medium` are not the row's real selectors, read `contacts-list.tsx` (~760-800) and use the actual ones.

- [ ] **Step 2: Run it and confirm failure**

Start the demo server with the Browser pane's `preview_start` `{ name: "orbit-demo" }` (port 3001), then:
Run: `BASE=http://localhost:3001 node scripts/dev/check-floating-rail.mjs`
Expected: FAIL on at least `/contacts?sort=closeness`, `/recruiters` and `/outreach` at 1440, and on the phone name width.

- [ ] **Step 3: Reserve the rail in the shell (`src/components/layout/app-shell.tsx`)**

```diff
-                "md:pr-[calc(2.5rem+var(--content-rail-gutter,0px))]",
+                "md:pr-[max(5rem,calc(2.5rem+var(--content-rail-gutter,0px)))]",
```
Add above the className list (no class names in the comment):
```ts
              // From md the bell and feedback rail floats over the right edge (2rem inset,
              // 2.5rem wide), so the column always reserves 5rem there, or the contacts
              // rail's gutter if that is larger.
```

- [ ] **Step 4: Remove the now-redundant opt-ins**

- `src/app/globals.css`: delete the media-query block keyed on `[data-clear-floating-controls]` and its comment; delete the `--orbit-top-rail` block if `grep -rn "orbit-top-rail" src` shows graph as its only user.
- Remove the `data-clear-floating-controls` attribute from every element carrying it, and the comment in `knowledge/page.tsx` that explains it.
- `src/app/(clerk)/(app)/(main)/graph/page.tsx`: remove the `md:pe-[var(--orbit-top-rail)]` class from its header row.

- [ ] **Step 5: Phone rows (`src/components/contacts/contacts-list.tsx`)**

After `<ClosenessChip ... />`, wrap the LinkedIn button, `<FollowUpRowButton ... />` and `<DeleteRowButton ... />` in:
```tsx
            {/* Phones give this width to the name: LinkedIn, follow-up and delete all
                live on the contact page, one tap away. */}
            <div className="hidden items-center gap-1 pointer-coarse:gap-4 md:flex">
              {/* the three existing buttons, unchanged */}
            </div>
```
(The comment inside JSX mentions no class names.) Keep the three buttons and their props byte-for-byte.

- [ ] **Step 6: Run and confirm**

Run: `BASE=http://localhost:3001 node scripts/dev/check-floating-rail.mjs && npx tsx scripts/smoke-tap-targets.ts && npx tsc --noEmit -p .`
Expected: all ok. Then screenshot `/graph`, `/reminders`, `/knowledge` and `/dashboard` at 1440×900 in the Browser pane and confirm nothing is double-padded or clipped.

- [ ] **Step 7: Commit**

```bash
git add src/components/layout/app-shell.tsx src/app/globals.css src/components/contacts/contacts-list.tsx scripts/dev/check-floating-rail.mjs
git add -u src
git commit -m "Layout: the floating bell never covers header actions; phone contact names get the row

The shell reserves the rail's width from md, replacing per-page opt-ins.
Phone rows hide LinkedIn, follow-up and delete (all on the contact page).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Whole-branch verification and PR

- [ ] **Step 1: Full checks**

```bash
npx tsx scripts/run-smoke.ts --check
npm test
npx tsc --noEmit -p .
npx eslint
```
Expected: all green. eslint has 0 errors on `main`, so any error is from this branch. If `smoke-radar-run` or `smoke-admin-analytics` fail on a time-of-day assertion, re-run them alone; both are known clock flakes. If any other smoke calling an Events/Radar/Outreach action now fails with `SurfaceHiddenError`, release that surface in the script as in Task 6 step 1.

- [ ] **Step 2: Browser walk (demo server on 3001, `orbit_preview_unreleased=1` cookie set)**

1. Dashboard Reminders card: mark "Send Sarah the retrieval write-up" done → Sarah leaves "Due follow-ups"; Undo → she returns.
2. Bell → a follow-up row → Mark done → the toast offers Undo → Undo restores the row.
3. Sarah's profile → open an interaction → Edit → both chevrons are disabled.
4. Settings → AI → Clear on a saved key shows the two-step confirm.
5. Settings → Your socials → `@ada` in X → Save shows the named error.
6. `/contacts?sort=closeness` at 1440: the Contacts/Recruiters toggle is clear of the bell.
7. Chat with no key: send → while "Starting…" the history rows are disabled.

- [ ] **Step 3: Open the PR**

Push and open a PR titled "Sprint A: correctness fixes from the Oct 8 audit". The body lists the 16 fixes by ID with one line each, then the "Behaviour changes users will notice" list from the spec, and ends with:

🤖 Generated with [Claude Code](https://claude.com/claude-code)
