/**
 * Avatar storage smoke tests.
 *
 * Guards the failure mode where a misconfigured storage backend was reported
 * as "this contact has no photo", which left the backfill job stuck at 0%
 * forever instead of saving photos or admitting it couldn't.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AvatarStorageError,
  downloadAndPersistAvatar,
  downloadImageBytes,
  isDurableAvatarUrl,
  parseImageDataUrl,
} from "../src/lib/contact-avatar";

// 1x1 JPEG — real enough for sharp to decode, small enough to inline.
const PIXEL_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";

async function withEnv(
  patch: Record<string, string | undefined>,
  fn: () => Promise<void>
) {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(patch)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function main() {
  const bytes = Buffer.from(PIXEL_JPEG_BASE64, "base64");
  let serverHits = 0;
  const server = createServer((_req, res) => {
    serverHits++;
    res.writeHead(200, { "Content-Type": "image/jpeg" });
    res.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const photoUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/photo.jpg`;
  // The fixture server is on loopback, which the production SSRF guard refuses (checked
  // below), so storage is exercised through the unguarded seam.
  const local = { fetch: (url: string, init: RequestInit) => fetch(url, init) };

  try {
    // --- SSRF: the default download path is guarded ---------------------------------------
    // A photo URL is user-supplied (the extension's `photoUrl`, a scraped og:image), so it
    // must never reach loopback, private ranges or the metadata address.
    const hitsBefore = serverHits;
    if ((await downloadImageBytes(photoUrl)) !== null || serverHits !== hitsBefore) {
      throw new Error("expected the guarded download to refuse a loopback photo URL");
    }

    // A public host that redirects inward: the guard must run again on the next hop.
    const realFetch = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response(null, {
        status: 302,
        headers: { location: "https://169.254.169.254/latest/meta-data/" },
      });
    }) as typeof fetch;
    try {
      const got = await downloadImageBytes("https://93.184.216.34/photo.jpg");
      if (got !== null || asked.length !== 1) {
        throw new Error(`expected the redirect to the metadata address to be refused, asked ${asked.join(", ")}`);
      }
    } finally {
      globalThis.fetch = realFetch;
    }

    // --- Stored-XSS: never serve script-capable image types from Orbit's origin ----------
    if (parseImageDataUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=") !== null) {
      throw new Error("expected an SVG data URL to be rejected");
    }
    if (!parseImageDataUrl(`data:image/jpeg;base64,${PIXEL_JPEG_BASE64}`)) {
      throw new Error("expected a JPEG data URL to parse");
    }
    if (isDurableAvatarUrl("https://evil.example/.public.blob.vercel-storage.com/x.jpg")) {
      throw new Error("expected a Blob-looking path on another host not to count as durable");
    }
    if (!isDurableAvatarUrl("https://abc123.public.blob.vercel-storage.com/avatars/x.jpg")) {
      throw new Error("expected a real Blob store URL to count as durable");
    }

    // Without Blob credentials the photo must still land somewhere durable,
    // instead of silently resolving to null for every single contact.
    await withEnv(
      { BLOB_READ_WRITE_TOKEN: undefined, BLOB_STORE_ID: undefined },
      async () => {
        const stored = await downloadAndPersistAvatar("contact-1", photoUrl, local);
        if (!stored) {
          throw new Error("expected a stored photo when Blob is unconfigured");
        }
        if (!isDurableAvatarUrl(stored)) {
          throw new Error(`expected a durable URL, got ${stored.slice(0, 40)}`);
        }
      }
    );

    // A broken storage backend must surface as a storage failure, not as a
    // per-contact miss — that distinction is what stops the 0%-forever job.
    await withEnv(
      { BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_bogus_store_bogustoken" },
      async () => {
        let thrown: unknown;
        try {
          await downloadAndPersistAvatar("contact-2", photoUrl, local);
        } catch (err) {
          thrown = err;
        }
        if (!(thrown instanceof AvatarStorageError)) {
          throw new Error(
            `expected AvatarStorageError from a bad Blob token, got ${String(thrown)}`
          );
        }
      }
    );

  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log("avatar storage smoke tests passed");
}

void main();
