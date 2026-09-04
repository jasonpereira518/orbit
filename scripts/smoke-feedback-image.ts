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

  console.log("\nAll feedback image checks passed.");
}

main();
process.exit(0);
