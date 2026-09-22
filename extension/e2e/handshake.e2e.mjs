/**
 * The web app ↔ extension handshake, against the REAL built extension.
 *
 *   npm run e2e:handshake     (builds dist-e2e-handshake with the app origin
 *                              set to this test's own server)
 *
 * What it promises (src/lib/handshake.ts, manifest externally_connectable):
 *   1. A page on the app's origin can ask "are you installed?" and gets the
 *      version back — and nothing about the user.
 *   2. A page on any other origin gets no answer at all; to it, there is no
 *      extension. (Chrome refuses it before the worker sees it.)
 *   3. "The user signed in" from the app writes the session poke that tells a
 *      signed-out panel to look again.
 */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { launchWithExtension } from "./chrome.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = process.env.E2E_EXTENSION_DIR ?? join(HERE, "..", "dist-e2e-handshake");
const PORT = 4319;
const APP = `http://localhost:${PORT}`;
const STRANGER = `http://127.0.0.1:${PORT}`;

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><title>app</title><p>app page</p>");
}).listen(PORT);

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

/** What a page gets back from asking the extension, or a reason it got nothing. */
const ask = (id, message) => `new Promise((resolve) => {
  const rt = window.chrome && window.chrome.runtime;
  if (!rt || typeof rt.sendMessage !== "function") return resolve({ none: "no chrome.runtime.sendMessage" });
  const timer = setTimeout(() => resolve({ none: "timeout" }), 2000);
  try {
    rt.sendMessage(${JSON.stringify(id)}, ${JSON.stringify(message)}, (reply) => {
      clearTimeout(timer);
      resolve(reply === undefined ? { none: String(rt.lastError && rt.lastError.message) } : reply);
    });
  } catch (e) { clearTimeout(timer); resolve({ none: String(e && e.message) }); }
})`;

const chrome = await launchWithExtension(EXTENSION);
try {
  const id = chrome.extensionId;

  console.log("1. the app's own origin is answered");
  await chrome.openTab("app", `${APP}/`);
  const hello = await chrome.evaluateIn("app", ask(id, { type: "orbit/hello" }));
  check("hello comes back ok, with a version", hello?.ok === true && typeof hello.version === "string", hello);
  check("…and nothing but version and sites", hello && Object.keys(hello).sort().join() === "ok,sites,version", hello);
  const junk = await chrome.evaluateIn("app", ask(id, { type: "orbit/open-panel" }));
  check("an unknown message gets no reply", Boolean(junk?.none), junk);

  console.log("2. any other origin gets nothing");
  await chrome.openTab("stranger", `${STRANGER}/`);
  const refused = await chrome.evaluateIn("stranger", ask(id, { type: "orbit/hello" }));
  check("no answer for another origin", Boolean(refused?.none), refused);

  console.log("3. 'signed in' pokes the panels");
  const before = await chrome.evaluateInWorker(`chrome.storage.session.get("orbit:session-poke").then((v) => v["orbit:session-poke"] ?? null)`);
  const poked = await chrome.evaluateIn("app", ask(id, { type: "orbit/session-changed" }));
  const after = await chrome.evaluateInWorker(`chrome.storage.session.get("orbit:session-poke").then((v) => v["orbit:session-poke"] ?? null)`);
  check("session-changed is acknowledged", poked?.ok === true, poked);
  check("…and writes the poke", typeof after === "number" && after !== before, { before, after });
} finally {
  await chrome.close();
  server.close();
}

if (failures > 0) {
  console.log(`\nhandshake e2e: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nhandshake e2e: all checks passed");
