/**
 * Feedback screenshot validation smoke tests.
 *
 * The two functions checked here are the boundary between "a user attached a picture" and
 * "a user chose what bytes Orbit serves back from its own origin, and under what content
 * type". `/api/feedback/screenshots/[shotId]` is same-origin and serves exactly what
 * `decodeScreenshot` admitted, with exactly the content type it chose — so a client whose
 * declared `image/webp` were believed over an HTML payload would have stored XSS.
 *
 * `sanitizePath` is the smaller sibling: the reported route is rendered in the admin
 * console, so a value that could become a link somewhere else has to die at the boundary
 * rather than being defused at render time by everyone who touches it.
 *
 * No database, no network.
 *
 * Run: npx tsx scripts/smoke-feedback-image.ts
 */
import {
  MAX_PATH,
  MAX_SCREENSHOT_BYTES,
  decodeScreenshot,
  sanitizePath,
} from "../src/lib/feedback-submission";
import { clampPanelOffset } from "../src/lib/feedback-report";
import { coverGeometry, selectionToCrop } from "../src/lib/screenshot-capture";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/** 1x1 WebP (lossy). */
const PIXEL_WEBP = Buffer.from(
  "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAQAcJaQAA3AA/vuUAAA=",
  "base64"
);
/** 1x1 PNG. */
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
/** 1x1 JPEG. */
const PIXEL_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==",
  "base64"
);

function dataUrl(declared: string, bytes: Buffer): string {
  return `data:${declared};base64,${bytes.toString("base64")}`;
}

function main() {
  console.log("Feedback screenshot validation\n");

  // THE assertion this file exists for. A payload that is not an image must be rejected
  // however confidently it is labelled — otherwise it comes back from our own origin
  // wearing the content type its author picked.
  const html = Buffer.from('<html><script>alert(document.cookie)</script></html>', "utf8");
  check(
    "an HTML payload declared as image/webp is rejected",
    decodeScreenshot(dataUrl("image/webp", html)) === null
  );
  check(
    "an SVG payload declared as image/png is rejected",
    decodeScreenshot(
      dataUrl("image/png", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', "utf8"))
    ) === null
  );

  // The declared type is not merely distrusted, it is unused: a real WebP mislabelled as
  // PNG comes back as WebP, because the bytes are the only thing that gets a vote.
  const mislabelled = decodeScreenshot(dataUrl("image/png", PIXEL_WEBP));
  check("a WebP declared as image/png decodes", mislabelled !== null);
  check(
    "...and is stored as the type its BYTES prove, not the declared one",
    mislabelled?.contentType === "image/webp",
    mislabelled?.contentType
  );

  for (const [name, bytes, expected] of [
    ["WebP", PIXEL_WEBP, "image/webp"],
    ["PNG", PIXEL_PNG, "image/png"],
    ["JPEG", PIXEL_JPEG, "image/jpeg"],
  ] as const) {
    const decoded = decodeScreenshot(dataUrl(expected, bytes));
    check(`a real ${name} is accepted as ${expected}`, decoded?.contentType === expected);
    check(`...with its bytes intact`, decoded?.buf.equals(bytes) === true);
  }

  // RIFF alone is not WebP — it is also WAV and AVI, which is why the container tag at
  // offset 8 is checked too.
  const riffOnly = Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.alloc(4),
    Buffer.from("WAVE", "ascii"),
    Buffer.alloc(16),
  ]);
  check("a RIFF/WAVE payload is not mistaken for WebP", decodeScreenshot(dataUrl("image/webp", riffOnly)) === null);

  check("a non-data: string is rejected", decodeScreenshot("https://evil.test/x.webp") === null);
  check("a data: URL with no comma is rejected", decodeScreenshot("data:image/webp;base64") === null);
  check("a non-base64 data: URL is rejected", decodeScreenshot("data:image/webp,RIFF") === null);
  check("an empty payload is rejected", decodeScreenshot("data:image/webp;base64,") === null);

  // Size is measured on the DECODED bytes. A base64 string is 4/3 the size of what it
  // carries, so checking the string would admit ~25% more than intended.
  const oversize = Buffer.concat([PIXEL_WEBP, Buffer.alloc(MAX_SCREENSHOT_BYTES)]);
  check(
    "a payload over the byte cap is rejected",
    decodeScreenshot(dataUrl("image/webp", oversize)) === null
  );

  console.log("");

  check("a normal path survives", sanitizePath("/contacts/abc?tab=notes") === "/contacts/abc?tab=notes");
  check("a fragment is stripped", sanitizePath("/dashboard#section") === "/dashboard");
  check("an absolute URL is rejected", sanitizePath("https://evil.test/x") === null);
  check("a javascript: URL is rejected", sanitizePath("javascript:alert(1)") === null);
  check("a protocol-relative URL is rejected", sanitizePath("//evil.test/x") === null);
  check("a bare word is rejected", sanitizePath("contacts") === null);
  check("undefined is rejected", sanitizePath(undefined) === null);
  check("an over-long path is rejected", sanitizePath(`/${"a".repeat(MAX_PATH)}`) === null);

  console.log("");

  // The crop overlay's geometry. This is where the alignment bug lived: the still used to
  // be fitted INSIDE the window with padding, so it was drawn smaller than the screen and
  // the pointer never sat on the pixel it appeared to be selecting.
  const viewport = { width: 1280, height: 860 };
  const tabFrame = { width: 2560, height: 1720 }; // a shared tab: viewport x dpr 2

  const tab = coverGeometry(tabFrame, viewport);
  check("a shared tab is placed at the window's origin", tab.left === 0 && tab.top === 0);
  check("...at exactly 1/dpr", tab.scale === 0.5, String(tab.scale));
  check(
    "...so the still covers the viewport exactly",
    tabFrame.width * tab.scale === viewport.width &&
      tabFrame.height * tab.scale === viewport.height
  );

  // The property the whole overlay rests on: a point on screen maps to the frame pixel
  // that is actually under it.
  const origin = selectionToCrop({ left: 0, top: 0, width: 10, height: 10 }, tab, tabFrame);
  check("the window's top-left maps to the frame's top-left", origin.x === 0 && origin.y === 0);

  const mid = selectionToCrop({ left: 640, top: 430, width: 100, height: 50 }, tab, tabFrame);
  check(
    "a point at the window's centre maps to the frame's centre",
    mid.x === 1280 && mid.y === 860,
    `${mid.x},${mid.y}`
  );
  check("a selection scales by the same factor", mid.w === 200 && mid.h === 100);

  const corner = selectionToCrop(
    { left: viewport.width - 20, top: viewport.height - 20, width: 20, height: 20 },
    tab,
    tabFrame
  );
  check(
    "a selection against the far edge reaches the frame's far edge",
    corner.x + corner.w === tabFrame.width && corner.y + corner.h === tabFrame.height,
    `${corner.x + corner.w} x ${corner.y + corner.h}`
  );

  // Whatever the window size, the mapping stays exact — the regression was size-dependent.
  for (const vp of [
    { width: 800, height: 600 },
    { width: 1920, height: 1080 },
    { width: 3000, height: 900 },
    { width: 400, height: 1200 },
  ]) {
    const g = coverGeometry(tabFrame, vp);
    const covers =
      tabFrame.width * g.scale >= vp.width - 0.001 &&
      tabFrame.height * g.scale >= vp.height - 0.001;
    check(`the still covers a ${vp.width}x${vp.height} window`, covers);
    const centre = selectionToCrop(
      { left: vp.width / 2, top: vp.height / 2, width: 4, height: 4 },
      g,
      tabFrame
    );
    check(
      `...and its centre still maps to the frame's centre`,
      Math.abs(centre.x - tabFrame.width / 2) <= 1 &&
        Math.abs(centre.y - tabFrame.height / 2) <= 1,
      `${centre.x},${centre.y}`
    );
  }

  // A whole-desktop share has a different aspect ratio: it overflows on one axis and is
  // centred, rather than being squashed to fit.
  const desktop = coverGeometry({ width: 3840, height: 2160 }, viewport);
  check("a desktop share overflows horizontally", desktop.left < 0);
  check("...and is centred, not distorted", Math.abs(desktop.top) < 0.001);

  // Pointer capture lets a drag leave the window entirely.
  const outside = selectionToCrop(
    { left: -500, top: -500, width: 10_000, height: 10_000 },
    tab,
    tabFrame
  );
  check(
    "a drag that leaves the window is clamped to the frame",
    outside.x === 0 &&
      outside.y === 0 &&
      outside.w === tabFrame.width &&
      outside.h === tabFrame.height
  );

  console.log("");

  // Dragging the panel around. The header is the only handle, so the clamp is what stops a
  // window being dragged somewhere it can never be dragged back from.
  const vp = { width: 1280, height: 860 };
  const box = { left: 880, top: 128, width: 384, height: 716 };
  const at = (dx: number, dy: number) =>
    clampPanelOffset({ start: box, startOffset: { x: 0, y: 0 }, delta: { x: dx, y: dy }, viewport: vp });

  const free = at(-300, 150);
  check("a drag well inside the window moves one-for-one", free.x === -300 && free.y === 150);

  check("dragging up stops at the top edge", at(0, -500).y === -box.top, String(at(0, -500).y));
  check(
    "...so the header can never leave the screen",
    box.top + at(0, -500).y === 0
  );

  const down = at(0, 5000);
  check("dragging down leaves a strip on screen", box.top + down.y === vp.height - 48);

  const far = at(-5000, 0);
  check("dragging left leaves a strip on screen", box.left + far.x === 48 - box.width);
  const right = at(5000, 0);
  check("dragging right leaves a strip on screen", box.left + right.x === vp.width - 48);

  // A second drag continues from where the first one left off rather than snapping back.
  const resumed = clampPanelOffset({
    start: { ...box, left: box.left - 300, top: box.top + 150 },
    startOffset: { x: -300, y: 150 },
    delta: { x: -100, y: -50 },
    viewport: vp,
  });
  check("a second drag accumulates onto the first", resumed.x === -400 && resumed.y === 100);

  console.log("\nAll feedback image checks passed.");
}

main();
process.exit(0);
