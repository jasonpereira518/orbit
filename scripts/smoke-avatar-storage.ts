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
  isDurableAvatarUrl,
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
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "image/jpeg" });
    res.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const photoUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/photo.jpg`;

  try {
    // Without Blob credentials the photo must still land somewhere durable,
    // instead of silently resolving to null for every single contact.
    await withEnv(
      { BLOB_READ_WRITE_TOKEN: undefined, BLOB_STORE_ID: undefined },
      async () => {
        const stored = await downloadAndPersistAvatar("contact-1", photoUrl);
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
          await downloadAndPersistAvatar("contact-2", photoUrl);
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
