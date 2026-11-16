/**
 * The phone nav and the desktop sidebar must reach the same pages.
 *
 * They are two hand-kept lists in `app-nav.ts` (`APP_NAV` for the sidebar, `MOBILE_BOTTOM_NAV`
 * plus `MOBILE_MORE_NAV` for the phone), and they had drifted: Settings was in the sidebar and
 * nowhere on a phone, where it could only be found through ⌘K's search. Nothing noticed.
 *
 * Pure — imports the lists, no browser.
 *
 * Run: npx tsx scripts/smoke-nav-parity.ts
 */
import { APP_NAV, MOBILE_BOTTOM_NAV, MOBILE_MORE_NAV } from "../src/components/layout/app-nav";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures++;
  console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
}

const bottom = MOBILE_BOTTOM_NAV.flatMap((item) => ("href" in item ? [item.href] : []));
const more = MOBILE_MORE_NAV.map((item) => item.href);
const phone = [...bottom, ...more];
const sidebar = APP_NAV.map((item) => item.href);

console.log("Phone nav against the sidebar");
const missing = sidebar.filter((href) => !phone.includes(href));
check("every sidebar page is reachable on a phone", missing.length === 0, missing.join(", "));
const extra = phone.filter((href) => !sidebar.includes(href));
check("the phone nav offers nothing the sidebar does not", extra.length === 0, extra.join(", "));
const dupes = phone.filter((href, i) => phone.indexOf(href) !== i);
check("no page appears twice (bar and More)", dupes.length === 0, dupes.join(", "));
check(
  "the bar has a More door when the overflow list is not empty",
  more.length === 0 || MOBILE_BOTTOM_NAV.some((item) => "id" in item && item.id === "more")
);

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nsmoke-nav-parity: all checks passed");
process.exit(0);
