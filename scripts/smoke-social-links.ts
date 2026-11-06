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
