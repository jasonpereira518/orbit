/**
 * Mutations and searches render the page once, not twice (LATENCY_PLAN SRV-1, CLI-3), and the
 * one render they keep is guaranteed by the server side.
 *
 * A Server Action that calls `revalidatePath` for the page on screen returns that page's fresh
 * render in its own response. Following it with `router.refresh()` rendered the whole route a
 * second time. Measured with `latency/renders.mjs`: 2 → 1 renders per contacts search and
 * 1 → 0 extra renders per logged interaction, with the timeline still showing the new entry.
 *
 * Removing the client refresh is only safe while the action keeps revalidating the page the
 * component lives on, so this pins both halves:
 *   - the client no longer refreshes in those places;
 *   - the server still revalidates `/contacts/{id}` in `logInteractionForUser`,
 *     `confirmBulkCapture` and `updateContactForUser`.
 * If a revalidate is ever removed, this fails and says which refresh has to come back.
 *
 * Pure (reads source). Run: npx tsx scripts/smoke-no-double-render.ts
 */
import { readFileSync } from "node:fs";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Source with comments removed, so prose that mentions `router.refresh()` is not a call. */
const read = (p: string) =>
  readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
/** The body of `function name(` / `async function name(` up to the next function declaration. */
function fnBody(src: string, name: string): string {
  const start = src.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) return "";
  const rest = src.slice(start + 1);
  const next = rest.search(/\n\s*(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(/);
  return next < 0 ? rest : rest.slice(0, next);
}

console.log("Client: no second render after a revalidating action...");
{
  const filters = read("src/components/contacts/contacts-filters.tsx");
  const apply = fnBody(filters, "apply");
  check("contacts search navigates with router.replace", /router\.replace\(href\)/.test(apply));
  check("and does not follow it with router.refresh()", !/router\.refresh\(\)/.test(apply));
  check("the contacts page still renders FreshOnArrival (re-reads a cached search URL)", /<RenderStamp\s*\/>/.test(read("src/app/(clerk)/(app)/(main)/contacts/page.tsx")));

  const sheet = read("src/components/contacts/log-interaction-sheet.tsx");
  check("log sheet, plain save: no router.refresh()", !/router\.refresh\(\)/.test(fnBody(sheet, "savePlain")));
  const afterConfirm = sheet.slice(sheet.indexOf("await confirmBulkCapture("), sheet.indexOf("toast.success(", sheet.indexOf("await confirmBulkCapture(")));
  check("log sheet, AI save: no router.refresh() before the toast", afterConfirm.length > 0 && !/router\.refresh\(\)/.test(afterConfirm));

  const form = read("src/components/contacts/contact-form.tsx");
  check(
    "contact form refreshes only for a create that stays on the page",
    /if \(!contactId && !redirectOnSuccess\) router\.refresh\(\);/.test(form) && (form.match(/router\.refresh\(\)/g) ?? []).length === 1
  );
}

console.log("\nServer: the actions still revalidate the page those components live on...");
{
  const writes = read("src/lib/contact-writes.ts");
  check(
    "logInteractionForUser revalidates /contacts/{id} (else restore the log sheet's refresh)",
    /revalidatePath\(`\/contacts\/\$\{input\.contactId\}`\)/.test(fnBody(writes, "logInteractionForUser"))
  );
  check(
    "updateContactForUser revalidates /contacts/{id} (else restore the contact form's refresh)",
    /revalidatePath\(`\/contacts\/\$\{id\}`\)/.test(fnBody(writes, "updateContactForUser"))
  );
  const capture = read("src/actions/capture.ts");
  check(
    "confirmBulkCapture revalidates every saved contact's page (else restore the AI save's refresh)",
    /for \(const id of out\.contactIds\) revalidatePath\(`\/contacts\/\$\{id\}`\)/.test(fnBody(capture, "confirmBulkCapture"))
  );
}

console.log(failures === 0 ? "\nAll double-render checks passed." : `\n${failures} check(s) FAILED.`);
if (failures) process.exit(1);
