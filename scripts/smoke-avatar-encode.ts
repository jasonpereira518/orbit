/**
 * Avatar encoder smoke tests.
 *
 * On Vercel `sharp` lives in exactly one function, `/api/avatars/encode`, and every other
 * function encodes photos by calling it (see `src/lib/avatar-encode.ts`). This guards both
 * halves: the route itself (fail-closed auth, decode, the error statuses) and the caller
 * (`downloadAndPersistAvatar` with `VERCEL` set), including what it stores when the encoder
 * is down — an unresized photo, never a lost one and never a thrown error.
 *
 * No server: the route handler is called directly, and `fetch` is stubbed to hand the
 * caller's request to it.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";
import { POST } from "../src/app/api/avatars/encode/route";
import { downloadAndPersistAvatar } from "../src/lib/contact-avatar";

const SECRET = "smoke-cron-secret";
const ENCODE_URL = "http://encoder.test/api/avatars/encode";

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${message}`);
  console.log(`  ok  ${message}`);
}

async function withEnv(patch: Record<string, string | undefined>, fn: () => Promise<void>) {
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

function post(body: Uint8Array | Buffer, headers: Record<string, string> = {}) {
  return POST(
    new Request(ENCODE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", ...headers },
      body: new Uint8Array(body),
    })
  );
}

const bearer = { Authorization: `Bearer ${SECRET}` };

/** Every request `fetch` saw for the encoder, and what to answer it with. */
type EncoderStub = { calls: Request[]; mode: "route" | "500" | "422" | "network" };

async function withEncoderStub(stub: EncoderStub, fn: () => Promise<void>) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    if (!request.url.startsWith(ENCODE_URL)) return realFetch(input as RequestInfo, init);
    stub.calls.push(request.clone());
    if (stub.mode === "network") throw new TypeError("fetch failed");
    if (stub.mode === "500") return new Response(null, { status: 500 });
    if (stub.mode === "422") return new Response(null, { status: 422 });
    return POST(request);
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function dimensions(dataUrl: string) {
  const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(dataUrl);
  assert(match, "the stored photo is an inline data URL");
  const meta = await sharp(Buffer.from(match![2], "base64")).metadata();
  return { width: meta.width, height: meta.height, format: meta.format, type: match![1] };
}

async function main() {
  // A photo bigger than the 256px avatar, small enough to inline unresized (the fallback).
  const photo = await sharp({
    create: { width: 600, height: 400, channels: 3, background: { r: 30, g: 120, b: 200 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  // Noise does not compress: well past MAX_PERSIST_BYTES (220KB) as raw bytes.
  const noise = await sharp({
    create: {
      width: 900,
      height: 900,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
      noise: { type: "gaussian", mean: 128, sigma: 60 },
    },
  })
    .jpeg({ quality: 95 })
    .toBuffer();

  // The photos are served over HTTP: a `data:` URL already counts as a durable avatar, so
  // `downloadAndPersistAvatar` would hand it back without encoding anything.
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "image/jpeg" });
    res.end(req.url === "/noise.jpg" ? noise : photo);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const photoUrl = `${origin}/photo.jpg`;
  const noiseUrl = `${origin}/noise.jpg`;
  // The fixture server is on loopback, which the production SSRF guard refuses, so photos
  // are fetched through the unguarded seam (still `globalThis.fetch`, so the stubs apply).
  const loopback = { fetch: (url: string, init: RequestInit) => fetch(url, init) };

  try {
  await withEnv({ CRON_SECRET: SECRET, NODE_ENV: "production" }, async () => {
    console.log("route");
    assert((await post(photo)).status === 401, "no bearer: 401");
    assert(
      (await post(photo, { Authorization: "Bearer not-the-secret" })).status === 401,
      "wrong bearer: 401"
    );

    const ok = await post(photo, bearer);
    assert(ok.status === 200, "valid bearer + image: 200");
    assert(ok.headers.get("content-type") === "image/jpeg", "answers image/jpeg");
    const meta = await sharp(Buffer.from(await ok.arrayBuffer())).metadata();
    assert(meta.width === 256 && meta.height === 256 && meta.format === "jpeg", "a 256x256 JPEG");

    assert((await post(Buffer.from("not an image at all"), bearer)).status === 422, "garbage bytes: 422");
    assert((await post(Buffer.alloc(0), bearer)).status === 422, "empty body: 422");
    assert(
      (await post(Buffer.alloc(5_000_001, 1), bearer)).status === 413,
      "over the input limit: 413"
    );
  });

  // Fail-closed: a deployment that lost CRON_SECRET must refuse, not open the door.
  await withEnv({ CRON_SECRET: undefined, NODE_ENV: "production", VERCEL: "1" }, async () => {
    assert((await post(photo)).status === 401, "no CRON_SECRET on Vercel: 401 to everyone");
  });

  console.log("caller, encoder up");
  await withEnv(
    {
      VERCEL: "1",
      CRON_SECRET: SECRET,
      APP_BASE_URL: "http://encoder.test",
      BLOB_READ_WRITE_TOKEN: undefined,
      BLOB_STORE_ID: undefined,
    },
    async () => {
      const up: EncoderStub = { calls: [], mode: "route" };
      await withEncoderStub(up, async () => {
        const stored = await downloadAndPersistAvatar("c1", photoUrl, loopback);
        assert(stored, "a photo is stored");
        assert(up.calls.length === 1, "one call to the encoder route");
        assert(up.calls[0].headers.get("authorization") === `Bearer ${SECRET}`, "it presents the bearer");
        const d = await dimensions(stored!);
        assert(d.width === 256 && d.height === 256, "and what is stored is the encoder's 256x256 output");
      });

      // The encoder failing must degrade to the unresized photo, exactly as an undecodable
      // image always has — not throw, and not lose the photo.
      for (const mode of ["500", "422", "network"] as const) {
        const down: EncoderStub = { calls: [], mode };
        await withEncoderStub(down, async () => {
          const stored = await downloadAndPersistAvatar("c2", photoUrl, loopback);
          assert(stored, `encoder ${mode}: the photo is still stored`);
          const d = await dimensions(stored!);
          assert(d.width === 600 && d.height === 400, `encoder ${mode}: stored unresized`);
        });
      }

      // ...but only while the raw photo is small enough to keep.
      const down: EncoderStub = { calls: [], mode: "500" };
      await withEncoderStub(down, async () => {
        const stored = await downloadAndPersistAvatar("c3", noiseUrl, loopback);
        assert(stored === null, "encoder down + an oversized photo: no photo, not a crash");
      });
    }
  );

  console.log("caller, local");
  await withEnv({ VERCEL: undefined, BLOB_READ_WRITE_TOKEN: undefined, BLOB_STORE_ID: undefined }, async () => {
    const local: EncoderStub = { calls: [], mode: "route" };
    await withEncoderStub(local, async () => {
      const stored = await downloadAndPersistAvatar("c4", photoUrl, loopback);
      assert(stored, "a photo is stored");
      assert(local.calls.length === 0, "off Vercel there is no HTTP hop: sharp is called directly");
      const d = await dimensions(stored!);
      assert(d.width === 256 && d.height === 256, "and it is still 256x256");
    });
  });

  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log("avatar encoder smoke tests passed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
