/**
 * The console's monochrome palette, and the one way it silently breaks.
 *
 * THE PORTAL PROBLEM. `Dialog`, `DropdownMenu` and `Tooltip` render into `document.body`,
 * which is outside the admin shell's subtree. The palette is a block of CSS custom
 * property overrides scoped to `.admin-theme`, so anything that portals out of that
 * subtree inherits the *product's* teal palette instead — a comp dialog opened from a
 * black-and-white console would come up looking like a different application.
 *
 * Nothing catches that: it type-checks, it lints, it renders, and it only looks wrong.
 * So this asserts structurally that every portal surface under `src/components/admin/`
 * carries `ADMIN_THEME_CLASS`.
 *
 * IT IS A SOURCE-LEVEL TEST ON PURPOSE. The console is unreachable in a browser locally
 * (`proxy.ts` 404s /admin without Clerk keys) and CSS custom properties resolve in a
 * layout engine, not in Node — so there is no runtime assertion available that would be
 * more honest than reading the source.
 *
 * Run: npx tsx scripts/smoke-admin-theme.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ADMIN_THEME_CLASS } from "../src/components/admin/theme";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const ADMIN_COMPONENTS = "src/components/admin";
const PORTAL_SURFACES = [
  "DialogContent",
  "DropdownMenuContent",
  "TooltipContent",
  "PopoverContent",
  "SheetContent",
];

function adminFiles(): string[] {
  return readdirSync(ADMIN_COMPONENTS)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => join(ADMIN_COMPONENTS, f));
}

function main() {
  const css = readFileSync("src/app/globals.css", "utf8");

  /* ------------------------------------------------------------------- the palette */

  check(
    "the console palette is defined",
    css.includes(`.${ADMIN_THEME_CLASS} {`),
    ADMIN_THEME_CLASS
  );
  check(
    "...and has a dark counterpart, so the app's theme toggle keeps working",
    css.includes(`.dark .${ADMIN_THEME_CLASS} {`)
  );

  // The ramp `hover:text-primary` depends on. If primary and foreground collapse to the
  // same value, every hover in the console silently stops doing anything.
  for (const [mode, selector] of [
    ["light", `.${ADMIN_THEME_CLASS} {`],
    ["dark", `.dark .${ADMIN_THEME_CLASS} {`],
  ] as const) {
    const body = css.slice(css.indexOf(selector), css.indexOf("}", css.indexOf(selector)));
    const read = (name: string) =>
      body.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim();
    const primary = read("primary");
    const foreground = read("foreground");
    const muted = read("muted-foreground");
    check(
      `${mode}: primary, foreground and muted-foreground are three distinct steps`,
      Boolean(primary && foreground && muted) &&
        new Set([primary, foreground, muted]).size === 3,
      `primary=${primary} foreground=${foreground} muted=${muted}`
    );
  }

  /* -------------------------------------------------------------- portal surfaces */

  const offenders: string[] = [];
  for (const file of adminFiles()) {
    const src = readFileSync(file, "utf8");
    for (const surface of PORTAL_SURFACES) {
      // Every opening tag for a portal surface, e.g. `<DialogContent ...>`.
      const opens = src.match(new RegExp(`<${surface}\\b[^>]*>`, "g")) ?? [];
      for (const tag of opens) {
        if (!tag.includes("ADMIN_THEME_CLASS")) offenders.push(`${file}: ${tag}`);
      }
    }
  }
  check(
    "every portal surface in the console carries the theme class",
    offenders.length === 0,
    offenders.join(" | ")
  );

  // Proves the check above can actually fail — a matcher that finds no portal surfaces at
  // all would pass this file forever while the console drifted.
  const surfacesFound = adminFiles().reduce((n, file) => {
    const src = readFileSync(file, "utf8");
    return (
      n +
      PORTAL_SURFACES.reduce(
        (m, s) => m + (src.match(new RegExp(`<${s}\\b[^>]*>`, "g")) ?? []).length,
        0
      )
    );
  }, 0);
  check(
    `...and the matcher actually finds them (${surfacesFound} surfaces)`,
    surfacesFound >= 3,
    String(surfacesFound)
  );

  /* ------------------------------------------------------------------ typography */

  const usingDisplaySerif = adminFiles()
    .concat(walkPages())
    .filter((f) => readFileSync(f, "utf8").includes("--font-display"));
  check(
    "no display serif anywhere in the console",
    usingDisplaySerif.length === 0,
    usingDisplaySerif.join(", ")
  );

  // The bug this fixed: `--font-mono` pointed at a variable nothing defined, so every
  // `font-mono` in the codebase silently inherited the body sans instead.
  check(
    "--font-mono resolves to a real family with a fallback stack",
    /--font-mono:\s*var\(--font-geist-mono\),\s*ui-monospace/.test(css)
  );
  const layout = readFileSync("src/app/layout.tsx", "utf8");
  check(
    "...and the variable it names is actually defined",
    layout.includes('variable: "--font-geist-mono"') &&
      layout.includes("geistMono.variable")
  );

  console.log("\nAll console theme checks passed.");
}

function walkPages(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tsx")) out.push(full);
    }
  };
  walk("src/app/(admin)");
  return out;
}

try {
  main();
  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}
