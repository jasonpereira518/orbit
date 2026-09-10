/**
 * Avatar resolution tier-ladder smoke tests.
 *
 * Guards the failure mode where the free tier was dead code and nobody noticed.
 * `fetchLinkedInPhotoUrl` built a `unavatar.io` URL and handed it to
 * `downloadAndPersistAvatar`, whose guard rejected any host on the *render*
 * blocklist — which lists `unavatar.io` because the browser must not hit it.
 * The fetch silently returned null every time, leaving Microlink's ~25/day free
 * tier as the only working source and capping the whole pipeline at ~25
 * contacts/day.
 *
 * These tests pin the two properties that broke:
 *   - the free tier is actually fetched, and
 *   - metered Microlink quota is not spent when the free tier succeeds.
 *
 * `fetch` is stubbed rather than hitting the network, so the ordering assertions
 * are deterministic and the suite stays offline.
 */
import { createHash } from "node:crypto";
import { runAvatarBackfillBatch } from "../src/lib/avatar-backfill";
import {
  AvatarSourceRateLimitError,
  downloadAndPersistAvatar,
  fetchGravatarPhotoUrl,
  fetchLinkedInPhotoUrl,
  isUnfetchableImageUrl,
  isUnusableAvatarUrl,
} from "../src/lib/contact-avatar";

// 1x1 JPEG — real enough for sharp to decode, small enough to inline.
const PIXEL_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";

const LINKEDIN_URL = "https://www.linkedin.com/in/tier-person/";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "  ok" : "FAIL"}  ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

type Handler = (url: string) => Response;

/** Swap in a stub `fetch`, recording every URL it is asked for. */
async function withFetch(handler: Handler, fn: (calls: string[]) => Promise<void>) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function jpegResponse() {
  return new Response(Buffer.from(PIXEL_JPEG_BASE64, "base64"), {
    status: 200,
    headers: { "Content-Type": "image/jpeg" },
  });
}

/** What unavatar.io actually returns for a LinkedIn lookup: a generated silhouette. */
const PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" id="person-accent-4">' +
  '<path fill="#e7e2dc" d="M0 0h128v128H0z"/></svg>';

function svgResponse(contentType = "image/svg+xml") {
  return new Response(PLACEHOLDER_SVG, {
    status: 200,
    headers: { "Content-Type": contentType },
  });
}

function microlinkResponse(imageUrl: string) {
  return Response.json({ status: "success", data: { image: { url: imageUrl } } });
}

async function main() {
  // Blob unconfigured, so a resolved photo persists inline as a data: URL.
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_STORE_ID;

  // ---- The guard split ---------------------------------------------------------
  // These two must disagree about unavatar.io. When they agreed, the tier died.
  check(
    "unavatar.io is unusable to RENDER (browser rate limits)",
    isUnusableAvatarUrl("https://unavatar.io/linkedin/someone")
  );
  check(
    "unavatar.io is still fetchable from the SERVER",
    !isUnfetchableImageUrl("https://unavatar.io/linkedin/someone")
  );
  check(
    "a licdn placeholder is not worth fetching",
    isUnfetchableImageUrl("https://static.licdn.com/aero/x/ghost.png")
  );
  check("an empty URL is not fetchable", isUnfetchableImageUrl("  "));

  // ---- Free tier succeeds: no metered quota is spent ----------------------------
  await withFetch(
    (url) => (url.includes("unavatar.io") ? jpegResponse() : new Response(null, { status: 500 })),
    async (calls) => {
      const stored = await fetchLinkedInPhotoUrl("tier-1", LINKEDIN_URL);
      check(
        "the free tier resolves a photo",
        Boolean(stored?.startsWith("data:image/")),
        String(stored).slice(0, 48)
      );
      check(
        "unavatar was actually fetched",
        calls.some((u) => u.includes("unavatar.io")),
        calls.join(", ") || "no calls"
      );
      check(
        "microlink quota is NOT spent when the free tier succeeds",
        !calls.some((u) => u.includes("api.microlink.io")),
        calls.join(", ")
      );
      check(
        "the stored value is never an unavatar.io URL",
        !String(stored).includes("unavatar.io")
      );
    }
  );

  // ---- Free tier misses: metered tier still backs it up -------------------------
  await withFetch(
    (url) => {
      if (url.includes("unavatar.io")) return new Response(null, { status: 404 });
      if (url.includes("api.microlink.io")) {
        return microlinkResponse("https://media.licdn.com/dms/image/real/photo.jpg");
      }
      return jpegResponse();
    },
    async (calls) => {
      const stored = await fetchLinkedInPhotoUrl("tier-2", LINKEDIN_URL);
      check(
        "microlink still backs up a free-tier miss",
        Boolean(stored?.startsWith("data:image/")),
        String(stored).slice(0, 48)
      );
      const unavatarAt = calls.findIndex((u) => u.includes("unavatar.io"));
      const microlinkAt = calls.findIndex((u) => u.includes("api.microlink.io"));
      check(
        "unavatar is tried BEFORE microlink",
        unavatarAt >= 0 && microlinkAt > unavatarAt,
        `unavatar@${unavatarAt}, microlink@${microlinkAt}`
      );
    }
  );

  // ---- Placeholder rejection ---------------------------------------------------
  // Unavatar answers LinkedIn with HTTP 200 and a generated person silhouette in SVG,
  // ignoring `fallback=false`. sharp decodes it, so an unguarded pipeline stores it as a
  // real headshot AND marks it durable — every LinkedIn contact gets a permanent fake
  // face and is never retried. Verified against the live service before writing this.
  //
  // Asserted on the download step rather than the whole ladder: the ladder correctly
  // moves on to Microlink after a placeholder, whose rate-limit state is process-wide
  // and would make this assertion depend on test ordering.
  const UNAVATAR_URL = "https://unavatar.io/linkedin/tier-person?fallback=false";

  await withFetch(
    () => svgResponse(),
    async () => {
      const stored = await downloadAndPersistAvatar("svg-1", UNAVATAR_URL);
      check(
        "a vector placeholder is NOT persisted as a headshot",
        stored === null,
        String(stored).slice(0, 60)
      );
    }
  );

  // Same placeholder, but the service lies about the type.
  await withFetch(
    () => svgResponse("image/png"),
    async () => {
      const stored = await downloadAndPersistAvatar("svg-2", UNAVATAR_URL);
      check(
        "an SVG mislabelled as image/png is still rejected (magic bytes)",
        stored === null,
        String(stored).slice(0, 60)
      );
    }
  );

  // The guard must not reject real raster photos.
  await withFetch(
    () => jpegResponse(),
    async () => {
      const stored = await downloadAndPersistAvatar("svg-3", UNAVATAR_URL);
      check(
        "a real raster photo still persists",
        Boolean(stored?.startsWith("data:image/")),
        String(stored).slice(0, 48)
      );
    }
  );

  // ---- Gravatar --------------------------------------------------------------
  await withFetch(
    () => new Response(null, { status: 404 }),
    async (calls) => {
      const stored = await fetchGravatarPhotoUrl("tier-3", "Nobody@Example.COM ");
      check("a Gravatar miss (d=404) persists nothing", stored === null, String(stored));
      check(
        "the gravatar request asks for d=404, not a generated placeholder",
        calls.some((u) => u.includes("d=404")),
        calls.join(", ")
      );
      // The caller passed " Nobody@Example.COM " — Gravatar only matches the
      // digest of the trimmed, lowercased address.
      const expected = createHash("sha256")
        .update("nobody@example.com", "utf8")
        .digest("hex");
      check(
        "the email is normalised (trimmed + lowercased) before hashing",
        calls.some((u) => u.includes(expected)),
        calls.join(", ")
      );
    }
  );

  await withFetch(
    () => jpegResponse(),
    async () => {
      const stored = await fetchGravatarPhotoUrl("tier-4", "someone@example.com");
      check(
        "a Gravatar hit is persisted durably",
        Boolean(stored?.startsWith("data:image/")),
        String(stored).slice(0, 48)
      );
      const noAt = await fetchGravatarPhotoUrl("tier-5", "not-an-email");
      check("a malformed address is not looked up", noAt === null);
    }
  );

  // ---- Quota is a deferral, never a miss --------------------------------------
  // unavatar.io allows 25 anonymous lookups a day (measured: x-rate-limit-limit: 25,
  // retry-after ~86,400s). Its 429 used to come back as a plain null, the backfill
  // cooldown-stamped the contact, and everyone past the 25th was muted for a month
  // even though ~70% of them had a real photo waiting. Runs LAST: the Unavatar
  // cooldown it trips is process-wide and would starve any Unavatar test after it.
  await withFetch(
    (url) => {
      if (url.includes("unavatar.io")) {
        return new Response('{"message":"Too Many Requests"}', {
          status: 429,
          headers: { "retry-after": "86400", "x-rate-limit-limit": "25" },
        });
      }
      // Microlink answers, but has no image — so nothing is found anywhere.
      return Response.json({ status: "success", data: {} });
    },
    async (calls) => {
      let thrown: unknown = null;
      let stored: string | null = null;
      try {
        stored = await fetchLinkedInPhotoUrl("quota-1", LINKEDIN_URL);
      } catch (err) {
        thrown = err;
      }
      check(
        "an Unavatar 429 is reported as a quota deferral, not as 'no photo'",
        thrown instanceof AvatarSourceRateLimitError && stored === null,
        `threw=${String(thrown)} stored=${String(stored)}`
      );

      const before = calls.filter((u) => u.includes("unavatar.io")).length;
      try {
        await fetchLinkedInPhotoUrl("quota-2", LINKEDIN_URL);
      } catch {
        // expected: still deferred
      }
      const after = calls.filter((u) => u.includes("unavatar.io")).length;
      check(
        "an exhausted Unavatar is not hammered again inside its cooldown",
        after === before,
        `unavatar calls before=${before} after=${after}`
      );
    }
  );

  // The batch must keep a deferred contact retryable: no cooldown stamp, no skipId.
  const marked: string[] = [];
  const batch = await runAvatarBackfillBatch(
    [{ id: "deferred-1", linkedinUrl: LINKEDIN_URL, email: null, remoteUrl: null }],
    {
      deadline: Date.now() + 5_000,
      persistRemote: async () => null,
      resolveLinkedIn: async () => {
        throw new AvatarSourceRateLimitError(Date.now() + 86_400_000, "unavatar.io");
      },
      resolveGravatar: async () => null,
      save: async () => {},
      markChecked: async (id) => void marked.push(id),
    }
  );
  check(
    "a quota-deferred contact is NOT cooldown-stamped",
    marked.length === 0,
    `markChecked called for ${marked.join(",")}`
  );
  check(
    "a quota-deferred contact is not handed back as a skipId",
    batch.failedIds.length === 0,
    batch.failedIds.join(",")
  );
  check("the batch reports when the quota resets", batch.rateLimitedUntil !== null);

  // …whereas a genuine miss IS stamped, so the cooldown still does its job.
  const marked2: string[] = [];
  await runAvatarBackfillBatch(
    [{ id: "miss-1", linkedinUrl: LINKEDIN_URL, email: null, remoteUrl: null }],
    {
      deadline: Date.now() + 5_000,
      persistRemote: async () => null,
      resolveLinkedIn: async () => null,
      resolveGravatar: async () => null,
      save: async () => {},
      markChecked: async (id) => void marked2.push(id),
    }
  );
  check("a genuine miss IS cooldown-stamped", marked2.includes("miss-1"));

  if (failures > 0) {
    console.error(`\n${failures} avatar tier check(s) failed`);
    process.exit(1);
  }
  console.log("\navatar tier smoke tests passed");
  process.exit(0);
}

void main();
