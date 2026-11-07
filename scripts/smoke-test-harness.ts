/**
 * The test harness tests itself: fixtures, the fetch mock, the known-bug exit codes and the
 * hermetic DNS preload. Each of these is something other smoke scripts trust blindly, so a
 * regression here would turn real failures green (a mock that falls through to the network,
 * a known-bug script that exits 0) rather than red.
 *
 * Pure tier: no database.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checker, EXIT_KNOWN_BUG } from "./smoke/check";
import { fakeUserId, makeCalendarEvent, makeContact, makeEmail, seeded } from "./smoke/factories";
import { hang, json, mockFetch, networkError, notJson, route, status } from "./smoke/http-mock";

const t = checker();

async function main() {
  console.log("\nfactories: deterministic, obviously fake");
  t.check("makeContact(n) is the same person every call", JSON.stringify(makeContact(3)) === JSON.stringify(makeContact(3)));
  t.check("different n, different person", makeContact(1).fullName !== makeContact(2).fullName);
  const people = Array.from({ length: 50 }, (_, i) => makeContact(i));
  t.check("every email is on a reserved domain", people.every((p) => /@example\.com$/.test(p.email)));
  t.check("every phone is in the 555-01xx fiction block", people.every((p) => /555-01\d\d$/.test(p.phone)));
  t.check("overrides win", makeContact(0, { company: "Override Inc" }).company === "Override Inc");
  t.check("makeEmail addresses a .test mailbox", makeEmail(2).to[0].endsWith(".test"));
  t.check("makeCalendarEvent attendees are fixture people", makeCalendarEvent(1, 3).attendees.length === 3);
  const a = seeded(42);
  const b = seeded(42);
  t.check("seeded() repeats for the same seed", [a(), a(), a()].join() === [b(), b(), b()].join());
  t.check("fakeUserId is prefixed and unique", fakeUserId("x").startsWith("smoke_x_") && fakeUserId("x") !== fakeUserId("x"));

  console.log("\nhttp-mock: answers, records, and never falls through to the network");
  const http = mockFetch([
    route("GET", "https://api.example.com/ok", () => json({ ok: true })),
    route("POST", /\/token$/, () => status(400, { error: "invalid_grant" })),
    route("GET", "https://api.example.com/html", () => notJson()),
    route("GET", "https://api.example.com/down", networkError),
    route("GET", "https://api.example.com/hang", () => hang()),
  ]);
  try {
    const ok = await fetch("https://api.example.com/ok", { headers: { authorization: "Bearer fake" } });
    t.check("a matched route answers", ok.status === 200 && (await ok.json()).ok === true);
    t.check("the request is recorded with its headers", http.calls[0]?.headers.authorization === "Bearer fake");

    const tok = await fetch("https://auth.example.com/token", { method: "POST", body: "grant_type=refresh_token" });
    t.check("an error status comes back as a Response", tok.status === 400 && (await tok.json()).error === "invalid_grant");
    t.check("the request body is recorded", http.calls[1]?.body === "grant_type=refresh_token");

    const html = await fetch("https://api.example.com/html");
    await t.rejects("notJson() really is not JSON", () => html.json());

    await t.rejects("networkError rejects like fetch does", () => fetch("https://api.example.com/down"), (e) => e instanceof TypeError);
    await t.rejects(
      "an unmatched URL rejects instead of reaching the network",
      () => fetch("https://unmocked.example.com/"),
      (e) => /no mock route matched/.test(String(e))
    );
    // A ref'd timer, not AbortSignal.timeout: that one is unref'd, so with nothing else
    // pending Node would exit before it fired (which `checker` now reports as a failure).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);
    await t.rejects(
      "a hung request still honours AbortSignal",
      () => fetch("https://api.example.com/hang", { signal: controller.signal }),
      (e) => (e as Error).name === "AbortError"
    );
    clearTimeout(timer);
  } finally {
    http.restore();
  }
  t.check("restore() puts the real fetch back", !String(globalThis.fetch).includes("no mock route matched"));

  console.log("\nchecker: exit codes run-smoke --bugs relies on");
  const dir = mkdtempSync(join(tmpdir(), "orbit-harness-"));
  const checkModule = join(process.cwd(), "scripts", "smoke", "check.ts");
  const runChild = (body: string) => {
    const file = join(dir, `c${Math.random().toString(36).slice(2)}.ts`);
    writeFileSync(file, `import { checker } from ${JSON.stringify(checkModule)};\nconst t = checker();\n${body}\n`);
    return spawnSync(process.execPath, [join("node_modules", "tsx", "dist", "cli.mjs"), file], { encoding: "utf8" }).status;
  };
  t.check("all checks pass → exit 0", runChild(`t.check("a", true); t.done("x");`) === 0);
  t.check("an ordinary failure → exit 1", runChild(`t.check("a", false); t.done("x");`) === 1);
  t.check("only a known bug → EXIT_KNOWN_BUG", runChild(`t.knownBug("b", false); t.done("x");`) === EXIT_KNOWN_BUG);
  t.check("a known bug plus a real failure → exit 1, not masked", runChild(`t.knownBug("b", false); t.check("a", false); t.done("x");`) === 1);
  t.check("a fixed known bug → exit 0 (so --bugs flags it for promotion)", runChild(`t.knownBug("b", true); t.done("x");`) === 0);
  t.check(
    "a script that stalls before done() → exit 1, not a silent pass",
    runChild(`t.check("a", true); await new Promise(() => {}); t.done("x");`) === 1
  );

  console.log("\nhermetic runs: DNS answered locally, real HTTP refused");
  const { lookup } = await import("node:dns/promises");
  if (!process.env.NODE_OPTIONS?.includes("hermetic.mjs")) {
    console.log("  (skipped — run through scripts/run-smoke.ts, which preloads it)");
  } else {
    const pub = await lookup("unavatar.io", { all: true });
    t.check("a public name resolves without a resolver", pub.length === 1 && pub[0].address === "93.184.215.14");
    await t.rejects("*.invalid is unresolvable", () => lookup("nothing.invalid"), (e) => (e as NodeJS.ErrnoException).code === "ENOTFOUND");
    t.check("localhost stays loopback", (await lookup("localhost")).address === "127.0.0.1");
    await t.rejects(
      "an unstubbed real request is refused, naming the URL",
      () => fetch("https://api.example.com/real"),
      (e) => /smoke runs are offline: a real request to https:\/\/api\.example\.com/.test(String(e))
    );
  }

  t.done("test harness");
}

main();
