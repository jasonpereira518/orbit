/**
 * Guards `runToastAction`, the helper every Undo in the app goes through.
 *
 * The data-layer inverses are round-tripped in smoke-toast-undo.ts. This covers what the
 * person actually sees: that an Undo button appears, that an Undo toast is NOT filed in
 * the notification center (its callback would not survive a reload), and — the one that
 * matters — that an inverse reporting `restored: false` never produces "Undone". Saying
 * "Undone" over a state that was not restored is worse than offering no Undo at all.
 *
 * Sonner is replaced with a recorder. The import is static on purpose: a dynamic
 * `import("sonner")` resolves a different module instance under tsx, so patching it
 * would never reach the copy `lib/toast.tsx` calls into.
 *
 * Run: npx tsx scripts/smoke-toast-actions.ts
 */
// The kept-notifications store reads localStorage and window; stub both for Node.
const store = new Map<string, string>();
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
g.window = { addEventListener() {}, removeEventListener() {} };

import { toast as sonnerToast } from "sonner";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++; console.log(`  FAIL ${name}`, extra ?? "");
}
/** The slice of sonner's per-toast options these checks read. */
type RecordedData = {
  action?: { label: string; onClick: () => void };
  className?: string;
  onDismiss?: unknown;
};
const calls: { variant: string; message: unknown; data: RecordedData }[] = [];
const patchable = sonnerToast as unknown as Record<string, unknown>;
for (const v of ["error", "success", "warning", "info", "message"] as const) {
  patchable[v] = (message: unknown, data?: RecordedData) => {
    calls.push({ variant: v, message, data: data ?? {} });
    return `id-${calls.length}`;
  };
}
const ticks = () => new Promise((r) => setTimeout(r, 5));
/** Press a recorded toast's Undo — and fail loudly, not silently, if there is none. */
async function pressUndo(call: { data: RecordedData } | undefined) {
  if (!call?.data.action) throw new Error("expected an Undo button on that toast");
  call.data.action.onClick();
  await ticks();
}
// A long message arrives wrapped in ExpandableToastMessage; read its text back out.
const text = (m: unknown) =>
  typeof m === "string" ? m : ((m as { props?: { message?: string } })?.props?.message ?? String(m));

async function main() {
  const { runToastAction } = await import("../src/lib/toast");

  console.log("success with an Undo");
  calls.length = 0;
  let refreshed = 0, inverted = 0;
  const result = await runToastAction({
    run: async () => ({ id: "r1" }),
    success: "Marked done",
    failure: "Couldn’t mark that done",
    refresh: () => { refreshed++; },
    undo: () => async () => { inverted++; return { restored: true }; },
  });
  const t = calls[0];
  check("returns the action's result", (result as { id?: string } | undefined)?.id === "r1");
  check("one success toast", calls.length === 1 && t.variant === "success" && text(t.message) === "Marked done", calls.map((c) => c.variant));
  check("it carries an Undo button", t.data.action?.label === "Undo");
  check("an Undo toast is NOT filed in the notification center", !String(t.data.className || "").includes("orbit-toast-kept") && t.data.onDismiss === undefined);
  check("refresh ran after the action", refreshed === 1);

  await pressUndo(t);
  check("pressing Undo runs the inverse", inverted === 1);
  const undone = calls[calls.length - 1];
  check("then says Undone", undone.variant === "success" && text(undone.message) === "Undone", text(undone.message));
  check("…and refreshes again", refreshed === 2);

  console.log("an inverse that finds the state has moved on");
  calls.length = 0;
  await runToastAction({ run: async () => 1, success: "Snoozed", failure: "x", undo: () => async () => ({ restored: false }) });
  await pressUndo(calls[0]);
  const last = calls[calls.length - 1];
  check("does NOT claim Undone", text(last.message) !== "Undone", text(last.message));
  check("says honestly that nothing changed", /nothing to undo/.test(text(last.message)), text(last.message));

  console.log("an inverse that throws");
  calls.length = 0;
  await runToastAction({ run: async () => 1, success: "Dismissed", failure: "x", undo: () => async () => { throw new Error('{"leak":"sk-live-1"}'); } });
  await pressUndo(calls[0]);
  const err = calls[calls.length - 1];
  check("reports an error", err.variant === "error");
  check("…in friendly words, never the raw message", !text(err.message).includes("sk-live") && /undo/i.test(text(err.message)), text(err.message));

  console.log("an inverse that returns a plain row (moveReminderToList)");
  calls.length = 0;
  await runToastAction({ run: async () => 1, success: "Moved", failure: "x", undo: () => async () => ({ id: "row", listId: "L" }) });
  await pressUndo(calls[0]);
  check("a plain row counts as restored", text(calls[calls.length - 1].message) === "Undone");

  console.log("no inverse available");
  calls.length = 0;
  await runToastAction({ run: async () => null, success: "Moved", failure: "x", undo: () => null });
  check("plain success, no Undo button", calls.length === 1 && calls[0].data.action === undefined);

  console.log("the action itself fails");
  calls.length = 0;
  let refreshedOnFail = 0;
  const failed = await runToastAction({
    run: async () => { throw new Error("An error occurred in the Server Components render. The specific message is omitted in production builds"); },
    success: "Marked done", failure: "Couldn’t mark that done — try again?",
    refresh: () => { refreshedOnFail++; },
    undo: () => async () => ({ restored: true }),
  });
  check("returns undefined", failed === undefined);
  check("no success toast", !calls.some((c) => c.variant === "success"));
  check("the production digest becomes the caller's copy", calls[0]?.variant === "error" && text(calls[0].message) === "Couldn’t mark that done — try again?", text(calls[0]?.message));
  check("does not refresh on failure", refreshedOnFail === 0);

  console.log("a success message derived from the result");
  calls.length = 0;
  await runToastAction({ run: async () => ({ remindersClosed: 2 }), success: (r) => `Cleared — ${r.remindersClosed} closed`, failure: "x" });
  check("uses the result", text(calls[0].message) === "Cleared — 2 closed", text(calls[0].message));

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
void main();
