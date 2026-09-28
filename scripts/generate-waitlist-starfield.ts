/**
 * Regenerates `public/waitlist/starfield.gif` — a tiny looping night-sky tile for waitlist
 * emails. Animated GIFs are what twinkle in Gmail / Outlook.com; classic Outlook desktop
 * freezes on frame 0, so that frame must still read as a starfield on its own.
 *
 * No deps: writes GIF89a directly. Run: npx tsx scripts/generate-waitlist-starfield.ts
 */
import { writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const W = 600;
const H = 220;
const FRAME_COUNT = 6;
const DELAY_CS = 18;

/** 0 = night sky (#05070f), matching `BG` in interest-list-email. */
const PALETTE: [number, number, number][] = [
  [5, 7, 15],
  [40, 48, 72],
  [90, 100, 130],
  [180, 190, 210],
  [232, 243, 241],
  [242, 193, 78],
  [120, 140, 180],
  [255, 255, 255],
];

function seeded(n: number) {
  let x = (Math.imul(n, 1103515245) + 12345) >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 0xffffffff;
  };
}

type Star = {
  x: number;
  y: number;
  base: number;
  amp: number;
  phase: number;
  size: number;
  gold: boolean;
};

const rand = seeded(42);
const stars: Star[] = [];
for (let i = 0; i < 90; i++) {
  stars.push({
    x: Math.floor(rand() * W),
    y: Math.floor(rand() * H),
    base: 1 + Math.floor(rand() * 3),
    amp: 1 + Math.floor(rand() * 2),
    phase: rand() * Math.PI * 2,
    size: rand() < 0.12 ? 2 : 1,
    gold: rand() < 0.08,
  });
}
for (let i = 0; i < 12; i++) {
  stars.push({
    x: Math.floor(rand() * W),
    y: Math.floor(rand() * H),
    base: 3,
    amp: 1,
    phase: rand() * Math.PI * 2,
    size: 2,
    gold: rand() < 0.25,
  });
}

function framePixels(t: number) {
  const px = new Uint8Array(W * H);
  for (const s of stars) {
    const twinkle = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 + s.phase);
    let level = Math.round(s.base + s.amp * twinkle);
    level = Math.max(1, Math.min(4, level));
    const color = s.gold && level >= 3 ? 5 : level === 4 ? 7 : level;
    for (let dy = 0; dy < s.size; dy++) {
      for (let dx = 0; dx < s.size; dx++) {
        const x = s.x + dx;
        const y = s.y + dy;
        if (x >= 0 && x < W && y >= 0 && y < H) px[y * W + x] = color;
      }
    }
    if (level >= 4 && s.size === 1) {
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ] as const) {
        const x = s.x + dx;
        const y = s.y + dy;
        if (x >= 0 && x < W && y >= 0 && y < H && px[y * W + x] === 0) px[y * W + x] = 2;
      }
    }
  }
  return px;
}

function lzwEncode(indexStream: Uint8Array, minCodeSize: number) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoi + 1;
  const maxCode = () => 1 << codeSize;

  const bitOut: number[] = [];
  let cur = 0;
  let curBits = 0;
  const writeCode = (code: number) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) {
      bitOut.push(cur & 0xff);
      cur >>= 8;
      curBits -= 8;
    }
  };

  let table = new Map<string, number>();
  const reset = () => {
    table = new Map();
    codeSize = minCodeSize + 1;
    nextCode = eoi + 1;
  };

  reset();
  writeCode(clear);
  let w = String.fromCharCode(indexStream[0]!);
  for (let i = 1; i < indexStream.length; i++) {
    const k = String.fromCharCode(indexStream[i]!);
    const wk = w + k;
    if (table.has(wk)) {
      w = wk;
    } else {
      const code = w.length === 1 ? w.charCodeAt(0) : table.get(w)!;
      writeCode(code);
      if (nextCode < 4096) {
        table.set(wk, nextCode++);
        if (nextCode === maxCode() && codeSize < 12) codeSize++;
      } else {
        writeCode(clear);
        reset();
      }
      w = k;
    }
  }
  writeCode(w.length === 1 ? w.charCodeAt(0) : table.get(w)!);
  writeCode(eoi);
  if (curBits > 0) bitOut.push(cur & 0xff);

  const blocks: Buffer[] = [Buffer.from([minCodeSize])];
  for (let i = 0; i < bitOut.length; i += 255) {
    const slice = bitOut.slice(i, i + 255);
    blocks.push(Buffer.from([slice.length, ...slice]));
  }
  blocks.push(Buffer.from([0]));
  return Buffer.concat(blocks);
}

const chunks: Buffer[] = [];
chunks.push(Buffer.from("GIF89a"));
const lsd = Buffer.alloc(7);
lsd.writeUInt16LE(W, 0);
lsd.writeUInt16LE(H, 2);
lsd[4] = 0x80 | (2 << 4) | 0x02;
lsd[5] = 0;
lsd[6] = 0;
chunks.push(lsd);
const gct = Buffer.alloc(8 * 3);
for (let i = 0; i < 8; i++) {
  gct[i * 3] = PALETTE[i]![0];
  gct[i * 3 + 1] = PALETTE[i]![1];
  gct[i * 3 + 2] = PALETTE[i]![2];
}
chunks.push(gct);
chunks.push(
  Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0"), 0x03, 0x01, 0x00, 0x00, 0x00])
);

for (let f = 0; f < FRAME_COUNT; f++) {
  const gce = Buffer.alloc(8);
  gce[0] = 0x21;
  gce[1] = 0xf9;
  gce[2] = 0x04;
  gce.writeUInt16LE(DELAY_CS, 4);
  chunks.push(gce);
  const desc = Buffer.alloc(10);
  desc[0] = 0x2c;
  desc.writeUInt16LE(W, 5);
  desc.writeUInt16LE(H, 7);
  chunks.push(desc);
  chunks.push(lzwEncode(framePixels(f / FRAME_COUNT), 3));
}
chunks.push(Buffer.from([0x3b]));

const out = join(process.cwd(), "public/waitlist/starfield.gif");
writeFileSync(out, Buffer.concat(chunks));
console.log(`wrote ${out} (${statSync(out).size} bytes, ${FRAME_COUNT}×${W}×${H})`);
