/**
 * The web app asking "is the Orbit extension installed here?" — the part that
 * runs in the page (src/lib/extension/presence.ts). The extension's side is
 * covered by extension/test/handshake.test.ts and a real-Chrome e2e.
 *
 *   - no configured ID, or no extension messaging (Safari, Firefox): null, at once
 *   - a well-formed hello: version and site names, nothing else kept
 *   - a malformed reply, a silent extension, or a throwing runtime: null — never
 *     a throw, never a hang
 *   - asked once per page load, however many surfaces ask
 *
 * Run: npx tsx scripts/smoke-extension-presence.ts
 */
let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    console.log(`  FAIL ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
    failures++;
  }
}

type Reply = ((message: unknown, cb: (r: unknown) => void) => void) | undefined;

/** A fresh module per case: the ID is read at import, the answer cached per load. */
async function load(id: string | undefined, reply: Reply) {
  if (id) process.env.NEXT_PUBLIC_EXTENSION_ID = id;
  else delete process.env.NEXT_PUBLIC_EXTENSION_ID;
  const calls: unknown[] = [];
  (globalThis as unknown as { window: unknown }).window = reply
    ? {
        chrome: {
          runtime: {
            sendMessage: (_id: string, message: unknown, cb: (r: unknown) => void) => {
              calls.push(message);
              reply(message, cb);
            },
          },
        },
      }
    : {};
  const mod = await import(`../src/lib/extension/presence.ts?case=${Math.random()}`);
  const links = await import(`../src/lib/extension/links.ts?case=${Math.random()}`);
  return { mod: mod as typeof import("../src/lib/extension/presence"), calls, links };
}

async function main() {
  console.log("presence");
  {
    const { mod, calls } = await load(undefined, (_m, cb) => cb({ ok: true, version: "1.0.0", sites: [] }));
    check("no configured ID: null, and the extension is never asked", (await mod.pingExtension()) === null && calls.length === 0);
  }
  {
    const { mod } = await load("abc", undefined);
    check("no extension messaging in this browser: null", (await mod.pingExtension()) === null);
  }
  {
    const { mod, calls } = await load("abc", (_m, cb) =>
      cb({ ok: true, version: "1.4.0", sites: ["LinkedIn", 7, "GitHub"], email: "x@y.z" })
    );
    const first = await mod.pingExtension();
    check("a hello: version and site names", JSON.stringify(first) === JSON.stringify({ version: "1.4.0", sites: ["LinkedIn", "GitHub"] }), first);
    await mod.pingExtension();
    check("asked once per page load", calls.length === 1, calls.length);
  }
  for (const [label, reply] of [
    ["a malformed reply", { ok: true }],
    ["a refusal", { ok: false, version: "1" }],
    ["no reply at all", undefined],
  ] as const) {
    const { mod } = await load("abc", (_m, cb) => cb(reply));
    check(`${label}: null`, (await mod.pingExtension()) === null);
  }
  {
    const { mod } = await load("abc", () => {
      /* never calls back */
    });
    const started = Date.now();
    const result = await mod.pingExtension(150);
    check("a silent extension times out to null", result === null && Date.now() - started < 1000);
  }
  {
    const { mod } = await load("abc", () => {
      throw new Error("Invalid extension id");
    });
    check("a throwing runtime: null, not a throw", (await mod.pingExtension()) === null);
  }
  {
    const { mod, calls } = await load("abc", (_m, cb) => cb({ ok: true }));
    mod.pokeExtensionSession();
    check("the session poke carries only its type", JSON.stringify(calls[0]) === JSON.stringify({ type: "orbit/session-changed" }), calls);
  }

  if (failures > 0) {
    console.log(`\nsmoke-extension-presence: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nsmoke-extension-presence: all checks passed");
  process.exit(0);
}

void main();
