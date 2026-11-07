/**
 * Every account page's brand theme stays readable: white text on the light-mode colour and
 * the dark-mode text on the dark-mode colour both clear WCAG AA (4.5:1), and the theme class
 * names the same colours the check reads. Also pins `whenLine`'s two forms.
 */
import { contrastRatio, PROVIDER_THEMES } from "../src/components/settings/provider-themes";
import { whenLine } from "../src/components/settings/account-page";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

for (const [id, t] of Object.entries(PROVIDER_THEMES)) {
  const light = contrastRatio(t.primary.light, t.primary.lightText);
  const dark = contrastRatio(t.primary.dark, t.primary.darkText);
  check(`${id}: light controls ≥ 4.5:1`, light >= 4.5, light.toFixed(2));
  check(`${id}: dark controls ≥ 4.5:1`, dark >= 4.5, dark.toFixed(2));
  check(
    `${id}: the class uses the colours checked`,
    t.className.includes(`[--primary:${t.primary.light}]`) && t.className.includes(`dark:[--primary:${t.primary.dark}]`),
  );
  check(`${id}: has a strip`, t.stripe.length > 0);
}

const now = new Date("2026-11-06T12:00:00Z");
check("recent reads as time ago", whenLine(new Date("2026-11-06T11:55:00Z"), now) === "5 minutes ago", whenLine(new Date("2026-11-06T11:55:00Z"), now));
check("older reads as a date", !whenLine(new Date("2026-10-01T12:00:00Z"), now).includes("ago"));
check("another year shows the year", whenLine(new Date("2025-10-01T12:00:00Z"), now).includes("2025"));

if (failures > 0) process.exit(1);
console.log("\nAll provider theme checks passed.");
process.exit(0);
