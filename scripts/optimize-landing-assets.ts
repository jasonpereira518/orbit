/**
 * Builds every raster, model and video the landing page serves from `public/landing/`.
 *
 * Two kinds of input:
 *
 * - `public/landing/planets/*.png` (committed): re-encoded as AVIF and WebP next to the PNG.
 *   Those nine are decorative, percentage-sized `<img>`s on /interest and in emails, served
 *   as a `<picture>` with the PNG as the fallback. Only with `--planets`, because a re-encode
 *   rewrites all eighteen committed files even when no PNG changed.
 * - `assets-src/landing/` (gitignored): the downloaded originals of the landing page's real
 *   imagery. Where each came from and its licence is recorded in
 *   `src/components/landing/landing-credits.ts`; re-download from the URLs there. A job
 *   whose original is missing is skipped, so this runs on a checkout without them.
 *
 * Outputs are committed and carry a version in the filename (`-v1`): `/landing/*` is cached
 * for a day and is not fingerprinted, so a changed file needs a new name.
 *
 * Only extensions the proxy matcher allows may land in `public/` (see `src/proxy.ts`;
 * `scripts/smoke-public-routes.ts` fails on any other).
 *
 * Run: npx tsx scripts/optimize-landing-assets.ts [--planets]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const PLANETS = join("public", "landing", "planets");
const SRC = join("assets-src", "landing");
const OUT = join("public", "landing");
const V = "v1";

const kb = (file: string) => `${(statSync(file).size / 1024).toFixed(0)} KB`;
const out = (dir: string, name: string) => {
  mkdirSync(join(OUT, dir), { recursive: true });
  return join(OUT, dir, name);
};
function source(...parts: string[]): string | null {
  const file = join(SRC, ...parts);
  if (existsSync(file)) return file;
  console.log(`skip   ${file} (original not downloaded)`);
  return null;
}

async function planets() {
  for (const file of readdirSync(PLANETS).filter((f) => f.endsWith(".png"))) {
    const base = file.replace(/\.png$/, "");
    const image = sharp(join(PLANETS, file));
    await image.clone().avif({ quality: 60, effort: 6 }).toFile(join(PLANETS, `${base}.avif`));
    await image.clone().webp({ quality: 82, effort: 6 }).toFile(join(PLANETS, `${base}.webp`));
  }
  console.log(`planets ${PLANETS}: re-encoded`);
}

/** Equirectangular surface maps for the hero's worlds: 1K to draw first, 2K to sharpen. */
const TEXTURES = ["sun", "mercury", "venus_atmosphere", "mars", "jupiter", "saturn", "uranus", "neptune"];

async function textures() {
  for (const body of TEXTURES) {
    const src = source(`tex-2k_${body}`, `2k_${body}.jpg`);
    if (!src) continue;
    const name = body.replace("_atmosphere", "");
    for (const [tier, width] of [["1k", 1024], ["2k", 2048]] as const) {
      const file = out("hero", `${name}-${tier}-${V}.webp`);
      await sharp(src).resize(width, width / 2).webp({ quality: 80, effort: 6 }).toFile(file);
      console.log(`${file} ${kb(file)}`);
    }
  }
  const ring = source("tex-2k_saturn_ring_alpha", "2k_saturn_ring_alpha.png");
  if (ring) {
    const file = out("hero", `saturn-ring-${V}.webp`);
    await sharp(ring).webp({ quality: 90, alphaQuality: 100, effort: 6 }).toFile(file);
    console.log(`${file} ${kb(file)}`);
  }
}

/**
 * The sky behind the hero, in two layers, both from NASA's Deep Star Maps 2020.
 *
 * The combined map (stars and Milky Way in one image) does not survive the hero's zoom: its
 * millions of faint stars are grain at any size a page can ship. So the glow and the stars
 * are taken from the two maps NASA publishes separately:
 *
 * - `milkyWay()`: the galaxy's diffuse light only. Smooth, so 2K magnifies cleanly. The
 *   original is linear-light; ffmpeg applies a 2.2 gamma on the way to PNG.
 * - `brightStars()`: the catalogue stars only. Not shipped as an image at all: the brightest
 *   few thousand are read out of it as positions and drawn by the scene as points, which
 *   stay sharp at any zoom.
 */
async function milkyWay() {
  const exr = source("milkyway", "milkyway_2020_4k_gal.exr");
  if (!exr) return;
  const png = join(SRC, "milkyway", "milkyway.png");
  // After the gamma, half the map sits on a lit floor (median about 0.10 of full scale). Cut
  // just under it and the sky away from the band is the page's own black. Done here, on the
  // 0..1 value, because the PNG is 16-bit and a later 8-bit offset would be a no-op.
  const curve = "clip((pow(val/maxval\\,1/2.2)-0.094)*1.25\\,0\\,1)*maxval";
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", exr,
    "-vf", `format=rgb48le,lutrgb=r=${curve}:g=${curve}:b=${curve}`,
    "-frames:v", "1", png,
  ]);
  for (const [tier, width] of [["1k", 1024], ["2k", 2048]] as const) {
    const file = out("hero", `milkyway-${tier}-${V}.webp`);
    // The light blur takes the catalogue's grain, which the zoom would otherwise magnify.
    await sharp(png).resize(width, width / 2).blur(1).webp({ quality: 78, effort: 6 }).toFile(file);
    console.log(`${file} ${kb(file)}`);
  }
}

const STAR_COUNT = 7000;
const STARS_MODULE = join("src", "components", "landing", "hero-stars.ts");

/**
 * Writes `hero-stars.ts`: the `STAR_COUNT` brightest stars of the catalogue map, six bytes
 * each (x and y in the map as uint16, a brightness byte, a blue-to-red byte), base64.
 *
 * A star in the map is a small splat, clipped to white when bright, so brightness is ranked
 * by the light in a window around the peak, not by the peak itself.
 */
async function brightStars() {
  const exr = source("hiptyc", "hiptyc_2020_8k_gal.exr");
  if (!exr) return;
  const png = join(SRC, "hiptyc", "hiptyc.png");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", exr, "-frames:v", "1", png]);
  const { data, info } = await sharp(png, { limitInputPixels: false }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const light = new Uint16Array(width * height);
  for (let i = 0, o = 0; i < light.length; i++, o += 3) light[i] = data[o] + data[o + 1] + data[o + 2];

  const WINDOW = 3;
  const found: { x: number; y: number; flux: number; warmth: number }[] = [];
  for (let y = WINDOW; y < height - WINDOW; y++) {
    for (let x = WINDOW; x < width - WINDOW; x++) {
      const i = y * width + x;
      const here = light[i];
      if (here < 40) continue;
      // A peak: no neighbour brighter, and none equal among those already scanned, so a
      // clipped star's flat top yields one peak, not one per pixel.
      if (
        light[i - 1] >= here || light[i - width - 1] >= here || light[i - width] >= here || light[i - width + 1] >= here ||
        light[i + 1] > here || light[i + width - 1] > here || light[i + width] > here || light[i + width + 1] > here
      ) continue;
      let flux = 0;
      let red = 0;
      let blue = 0;
      for (let dy = -WINDOW; dy <= WINDOW; dy++) {
        for (let dx = -WINDOW; dx <= WINDOW; dx++) {
          const j = i + dy * width + dx;
          flux += light[j];
          red += data[j * 3];
          blue += data[j * 3 + 2];
        }
      }
      found.push({ x, y, flux, warmth: red / Math.max(1, red + blue) });
    }
  }
  found.sort((a, b) => b.flux - a.flux);
  const stars = found.slice(0, STAR_COUNT);
  const brightest = Math.log(stars[0].flux);
  const faintest = Math.log(stars[stars.length - 1].flux);
  const bytes = Buffer.alloc(stars.length * 6);
  stars.forEach((star, n) => {
    bytes.writeUInt16LE(Math.round(((star.x + 0.5) / width) * 65535), n * 6);
    bytes.writeUInt16LE(Math.round(((star.y + 0.5) / height) * 65535), n * 6 + 2);
    bytes[n * 6 + 4] = Math.round(((Math.log(star.flux) - faintest) / (brightest - faintest)) * 255);
    bytes[n * 6 + 5] = Math.round(Math.min(1, Math.max(0, (star.warmth - 0.35) / 0.3)) * 255);
  });
  writeFileSync(
    STARS_MODULE,
    `/**\n * Generated by scripts/optimize-landing-assets.ts. Do not edit.\n *\n` +
      ` * The ${stars.length} brightest stars of NASA's Deep Star Maps 2020 (Hipparcos-2 and Tycho-2), in\n` +
      ` * galactic coordinates: six bytes each, base64. Bytes 0-1 and 2-3 are x and y across the\n` +
      ` * map (uint16, little-endian), byte 4 is brightness, byte 5 runs from blue (0) to red (255).\n` +
      ` * Credit: see landing-credits.ts. Decoded by hero-scene.ts.\n */\n` +
      `export const HERO_STARS = "${bytes.toString("base64")}";\n`,
  );
  console.log(`${STARS_MODULE} ${kb(STARS_MODULE)} (${found.length} peaks found, ${stars.length} kept)`);
}

/**
 * The comet's nucleus. NASA's GLB embeds one PNG texture; GLTFLoader would read that
 * through a `blob:` fetch, which the production CSP's `connect-src` refuses. So the
 * texture ships as its own WebP (loaded like every other map) and the GLB keeps only the
 * mesh: no images, no extensions, nothing for the loader to fetch.
 */
async function nucleus() {
  const src = source("bennu", "Bennu_1_1.glb");
  if (!src) return;
  const buf = readFileSync(src);
  const jsonLength = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLength).toString("utf8"));
  const binStart = 20 + jsonLength + 8;
  const bin = buf.subarray(binStart, binStart + buf.readUInt32LE(20 + jsonLength));
  type View = { byteOffset?: number; byteLength: number };
  const bytesOf = (v: View) => bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);

  const imageView: number = json.images[0].bufferView;
  const texture = out("hero", `bennu-${V}.webp`);
  await sharp(bytesOf(json.bufferViews[imageView])).resize(1024).webp({ quality: 82, effort: 6 }).toFile(texture);

  const chunks: Buffer[] = [];
  const remap = new Map<number, number>();
  let offset = 0;
  json.bufferViews = (json.bufferViews as View[]).flatMap((view, i) => {
    if (i === imageView) return [];
    const bytes = bytesOf(view);
    const pad = (4 - (bytes.length % 4)) % 4;
    remap.set(i, remap.size);
    const moved = { ...view, byteOffset: offset };
    chunks.push(bytes, Buffer.alloc(pad));
    offset += bytes.length + pad;
    return [moved];
  });
  for (const accessor of json.accessors) accessor.bufferView = remap.get(accessor.bufferView);
  delete json.images;
  delete json.textures;
  delete json.samplers;
  for (const material of json.materials) delete material.pbrMetallicRoughness?.baseColorTexture;
  json.buffers = [{ byteLength: offset }];

  let text = JSON.stringify(json);
  text += " ".repeat((4 - (Buffer.byteLength(text) % 4)) % 4);
  const jsonChunk = Buffer.from(text, "utf8");
  const header = Buffer.alloc(12);
  header.write("glTF", 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + offset, 8);
  const chunkHead = (length: number, type: string) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(length, 0);
    head.write(type, 4);
    return head;
  };
  const glb = out("hero", `bennu-${V}.glb`);
  writeFileSync(glb, Buffer.concat([header, chunkHead(jsonChunk.length, "JSON"), jsonChunk, chunkHead(offset, "BIN\0"), ...chunks]));
  console.log(`${glb} ${kb(glb)}, ${texture} ${kb(texture)}`);
}

/** Section plates and screenshots: `<picture>` sources at two widths. */
const PICTURES: { src: string[]; dir: string; name: string; widths: number[] }[] = [
  { src: ["orion", "heic0516d.jpg"], dir: "photos", name: "orion", widths: [1600, 2400] },
  { src: ["carina", "weic2205a.jpg"], dir: "photos", name: "carina", widths: [1600, 2400] },
  // Captured by scripts/dev/capture-landing.mjs.
  { src: ["shots", "poster-wide.png"], dir: "hero", name: "poster-wide", widths: [1280, 2560] },
  { src: ["shots", "poster-tall.png"], dir: "hero", name: "poster-tall", widths: [780] },
  { src: ["shots", "poster-rings.png"], dir: "hero", name: "poster-rings", widths: [1200] },
  // Each step twice: the app's desktop layout, and its phone layout for phones.
  ...["step-import", "step-person", "step-today"].flatMap((name) => [
    { src: ["shots", `${name}.png`], dir: "shots", name, widths: [800, 1600] },
    { src: ["shots", `${name}-phone.png`], dir: "shots", name: `${name}-phone`, widths: [860] },
  ]),
];

async function pictures() {
  for (const picture of PICTURES) {
    const src = source(...picture.src);
    if (!src) continue;
    for (const width of picture.widths) {
      const base = out(picture.dir, `${picture.name}-${V}-${width}`);
      const image = sharp(src, { limitInputPixels: false }).resize({ width, withoutEnlargement: true });
      await image.clone().avif({ quality: 55, effort: 6 }).toFile(`${base}.avif`);
      await image.clone().webp({ quality: 80, effort: 6 }).toFile(`${base}.webp`);
      console.log(`${base}.avif ${kb(`${base}.avif`)}, .webp ${kb(`${base}.webp`)}`);
    }
  }
}

/**
 * The finale's loop: nine seconds of city lights from the middle of the pass (the original
 * opens on a title card and ends on a NASA logo card, neither of which may ship). The last
 * second cross-fades into the second before the clip starts, so the loop has no cut.
 */
async function video() {
  const src = source("earthnight", "EastCoast-Night_ISS061_2019-12.mp4");
  if (!src) return;
  const START = 15;
  const filter =
    // The pass is exposed for the stars above it; lifted here so the cities read on a page.
    `[0:v]trim=start=${START}:duration=10,setpts=PTS-STARTPTS,fps=24,scale=1080:-2,eq=contrast=1.25:gamma=1.35,split[a][b];` +
    `[a]trim=start=1:duration=9,setpts=PTS-STARTPTS[main];` +
    `[b]trim=start=0:duration=1,setpts=PTS-STARTPTS[head];` +
    `[main][head]xfade=transition=fade:duration=1:offset=8[v]`;
  const common = ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-filter_complex", filter, "-map", "[v]", "-an"];
  const mp4 = out("video", `earth-night-${V}.mp4`);
  const webm = out("video", `earth-night-${V}.webm`);
  execFileSync("ffmpeg", [...common, "-c:v", "libx264", "-crf", "27", "-preset", "slow", "-pix_fmt", "yuv420p", "-g", "48", "-movflags", "+faststart", mp4]);
  execFileSync("ffmpeg", [...common, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "38", "-row-mt", "1", webm]);
  const frame = join(SRC, "earthnight", "poster.png");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", mp4, "-frames:v", "1", frame]);
  const poster = out("video", `earth-night-${V}`);
  await sharp(frame).avif({ quality: 55, effort: 6 }).toFile(`${poster}.avif`);
  await sharp(frame).webp({ quality: 80, effort: 6 }).toFile(`${poster}.webp`);
  console.log(`${mp4} ${kb(mp4)}, ${webm} ${kb(webm)}, poster ${kb(`${poster}.avif`)}`);
}

async function main() {
  if (process.argv.includes("--planets")) await planets();
  await textures();
  await milkyWay();
  await brightStars();
  await nucleus();
  await pictures();
  await video();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
