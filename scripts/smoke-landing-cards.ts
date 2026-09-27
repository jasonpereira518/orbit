/**
 * Asserts that every glass card on the marketing landing page goes through `<GlassCard>`.
 *
 * The press animation lives in that one component, so a card written as a raw
 * `<div className="landing-glass …">` gets the surface and silently misses the press —
 * and nothing catches it, because the page still looks right until someone clicks. This
 * is the same failure shape as a marketing page missing from PUBLIC_ROUTES: the wrong
 * behaviour is invisible in the render.
 *
 * The check is deliberately about the class, not about clicking: `.landing-glass` IS the
 * card surface, so anything wearing it is a card and should press like one.
 *
 * Run: npx tsx scripts/smoke-landing-cards.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LANDING_DIR = "src/components/landing";
/** Where the class is allowed to appear in TSX: the component that owns the press. */
const OWNER = "glass-card.tsx";
const CARD_CLASS = "landing-glass";

function tsxFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".tsx"))
    .sort();
}

function main() {
  const offenders: Array<{ file: string; line: number; text: string }> = [];
  let ownerSeen = false;

  for (const file of tsxFiles(LANDING_DIR)) {
    const lines = readFileSync(join(LANDING_DIR, file), "utf8").split("\n");
    for (const [i, line] of lines.entries()) {
      // A comment explaining the class is not a card. Only the class actually being
      // applied counts, which in this codebase always means a quoted className.
      if (!line.includes(`"${CARD_CLASS}`) && !line.includes(` ${CARD_CLASS} `)) continue;
      if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) continue;
      if (file === OWNER) {
        ownerSeen = true;
        continue;
      }
      offenders.push({ file, line: i + 1, text: line.trim() });
    }
  }

  console.log(`Scanned ${tsxFiles(LANDING_DIR).length} components in ${LANDING_DIR}/\n`);

  if (!ownerSeen) {
    console.error(
      `FAILED: ${LANDING_DIR}/${OWNER} does not apply .${CARD_CLASS} — the press ` +
        `component is missing or has stopped carrying the card surface.`
    );
    process.exit(1);
  }
  console.log(`  ok   ${OWNER} owns .${CARD_CLASS}`);

  for (const { file, line, text } of offenders) {
    console.log(`  FAIL ${file}:${line}  ${text.slice(0, 88)}`);
  }

  if (offenders.length > 0) {
    console.error(
      `\nFAILED: ${offenders.length} card(s) apply .${CARD_CLASS} directly instead of ` +
        `rendering <GlassCard>, so they get the glass surface without the press ` +
        `animation. Swap them for <GlassCard> from @/components/landing/glass-card.`
    );
    process.exit(1);
  }

  console.log("\nEvery landing glass card goes through <GlassCard>.");
}

main();
