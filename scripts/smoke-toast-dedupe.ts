/**
 * Guards the duplicate-toast check in `lib/toast.tsx`: asking for a toast that is already on
 * screen updates it in place instead of stacking a second copy.
 *
 * The duplicates it exists for have no single owner: the same save toasted by a child and by
 * the parent handling its callback, a handler run twice by a double click, an effect React's
 * dev StrictMode runs twice. So this checks the helper, not any one caller.
 *
 * As in smoke-toast-actions.ts, sonner is replaced with a recorder (the import is static so
 * the patch reaches the copy `lib/toast.tsx` calls), plus a `getToasts` standing in for what
 * is currently on screen.
 *
 * Run: npx tsx scripts/smoke-toast-dedupe.ts
 */
const store = new Map<string, string>();
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
g.window = { addEventListener() {}, removeEventListener() {} };

import { toast as sonnerToast } from "sonner";
import { toast } from "../src/lib/toast";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++; console.log(`  FAIL ${name}`, extra ?? "");
}

type RecordedData = { id?: string | number; action?: unknown };
const calls: { variant: string; data: RecordedData }[] = [];
let onScreen: { id: string | number }[] = [];
const patchable = sonnerToast as unknown as Record<string, unknown>;
for (const v of ["error", "success", "warning", "info", "message"] as const) {
  patchable[v] = (_message: unknown, data?: RecordedData) => {
    const id = data?.id ?? `id-${calls.length + 1}`;
    calls.push({ variant: v, data: data ?? {} });
    if (!onScreen.some((t) => t.id === id)) onScreen.push({ id });
    return id;
  };
}
patchable.getToasts = () => onScreen;
const last = () => calls[calls.length - 1];
const reset = () => { calls.length = 0; onScreen = []; };

function main() {
  console.log("a repeat while the first is on screen");
  reset();
  const first = toast.success("Saved");
  const second = toast.success("Saved");
  check("the second call reuses the first toast's id", second === first, { first, second });
  check("and reached sonner as an update (same id)", last().data.id === first);
  check("so only one toast is on screen", onScreen.length === 1, onScreen);

  console.log("a repeat after the first has gone");
  reset();
  const a = toast.success("Saved");
  onScreen = []; // timed out or dismissed
  const b = toast.success("Saved");
  check("is a new toast, not a revival of a dead id", b !== a && last().data.id === undefined, { a, b });

  console.log("things that are not duplicates");
  reset();
  const s1 = toast.success("Saved");
  const s2 = toast.success("Saved changes");
  check("a different message", s1 !== s2);
  const m1 = toast.message("Saved");
  check("the same words under another variant", m1 !== s1);
  const d1 = toast.success("Saved", { description: "Your bio" });
  const d2 = toast.success("Saved", { description: "Your links" });
  check("the same title with a different description", d1 !== d2 && d2 !== s1);
  const d3 = toast.success("Saved", { description: "Your bio" });
  check("the same title and description is the duplicate", d3 === d1);

  console.log("errors");
  reset();
  const e1 = toast.error("That didn’t save — try again?");
  const e2 = toast.error("That didn’t save — try again?");
  check("an identical error collapses too", e1 === e2 && onScreen.length === 1, { e1, e2 });

  console.log("exemptions");
  reset();
  const u1 = toast.success("Marked done", { action: { label: "Undo", onClick: () => {} } });
  const u2 = toast.success("Marked done", { action: { label: "Undo", onClick: () => {} } });
  check("two Undo toasts stay two (each undoes a different row)", u1 !== u2 && onScreen.length === 2, { u1, u2 });
  reset();
  const own = toast.success("Importing", { id: "import-1" });
  toast.success("Importing", { id: "import-1" });
  check("a caller-chosen id is passed through untouched", own === "import-1" && calls.every((c) => c.data.id === "import-1"));

  if (failures > 0) { console.log(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("toast dedupe smoke tests passed");
  process.exit(0);
}
main();
