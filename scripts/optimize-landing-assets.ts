/**
 * Pre-encodes the landing page's planet art as AVIF and WebP next to the PNG originals.
 *
 * The nine planets are decorative, percentage-sized, motion-transformed `<img>`s — an
 * awkward fit for next/image — so they are served as a `<picture>` with AVIF and WebP
 * sources and the PNG as the fallback. Run once whenever a PNG changes; the outputs are
 * committed. ~1.3 MB of PNG becomes ~300 KB for a modern browser.
 *
 * Run: npx tsx scripts/optimize-landing-assets.ts
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const DIR = join("public", "landing", "planets");

async function main() {
  const pngs = readdirSync(DIR).filter((f) => f.endsWith(".png"));
  let before = 0;
  let avifTotal = 0;
  let webpTotal = 0;
  for (const file of pngs) {
    const src = join(DIR, file);
    const base = file.replace(/\.png$/, "");
    before += statSync(src).size;
    const image = sharp(src);
    await image.clone().avif({ quality: 60, effort: 6 }).toFile(join(DIR, `${base}.avif`));
    await image.clone().webp({ quality: 82, effort: 6 }).toFile(join(DIR, `${base}.webp`));
    const a = statSync(join(DIR, `${base}.avif`)).size;
    const w = statSync(join(DIR, `${base}.webp`)).size;
    avifTotal += a;
    webpTotal += w;
    console.log(`${base.padEnd(8)} png ${(statSync(src).size / 1024).toFixed(0).padStart(4)} KB → avif ${(a / 1024).toFixed(0).padStart(4)} KB, webp ${(w / 1024).toFixed(0).padStart(4)} KB`);
  }
  console.log(`\ntotal png ${(before / 1024).toFixed(0)} KB → avif ${(avifTotal / 1024).toFixed(0)} KB, webp ${(webpTotal / 1024).toFixed(0)} KB`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
