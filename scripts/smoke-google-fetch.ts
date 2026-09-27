/**
 * Google HTTP calls: backoff on quota answers, a fresh timeout per attempt, and a 401 in
 * the middle of a scan treated as a dead session rather than as "nothing here".
 *
 * No network: the wrapper takes an injected fetch and sleep; the gmail.ts helpers are driven
 * through a stubbed `globalThis.fetch`.
 *
 * Run: npx tsx scripts/smoke-google-fetch.ts
 */
import { googleFetchWithRetry, GOOGLE_MAX_RETRIES, GOOGLE_MAX_RETRY_DELAY_MS } from "../src/lib/google-fetch";
import { fetchGmailHeaders, fetchGoogleProfileEmail, fetchGooglePeopleContacts } from "../src/lib/gmail";
import { fetchCalendarPage } from "../src/lib/connectors/google-calendar";
import { ReauthRequiredError } from "../src/lib/errors";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Script = (call: number, url: string) => Response;
function scripted(script: Script) {
  const calls: { url: string; signal: AbortSignal | null | undefined }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, signal: init?.signal });
    return script(calls.length, url);
  }) as typeof fetch;
  return { impl, calls };
}

const quota403 = () =>
  new Response('{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}', { status: 403 });

const realFetch = globalThis.fetch;

async function main() {
  console.log("googleFetchWithRetry");
  {
    const sleeps: number[] = [];
    const { impl, calls } = scripted((n) => (n === 1 ? new Response("", { status: 429 }) : new Response("{}", { status: 200 })));
    const res = await googleFetchWithRetry("https://example.test/a", { timeoutMs: 1000, fetchImpl: impl, sleep: async (ms) => { sleeps.push(ms); } });
    check("a 429 is retried", res.status === 200 && calls.length === 2, `${calls.length} calls`);
    check("…after one backoff sleep", sleeps.length === 1);
    check("each attempt gets its own signal", Boolean(calls[0].signal) && calls[0].signal !== calls[1].signal);
  }
  {
    const { impl, calls } = scripted((n) => (n === 1 ? quota403() : new Response("{}", { status: 200 })));
    await googleFetchWithRetry("https://example.test/b", { timeoutMs: 1000, fetchImpl: impl, sleep: async () => {} });
    check("a quota 403 is retried", calls.length === 2, `${calls.length} calls`);
  }
  {
    const { impl, calls } = scripted(() => new Response('{"error":"forbidden"}', { status: 403 }));
    const res = await googleFetchWithRetry("https://example.test/c", { timeoutMs: 1000, fetchImpl: impl, sleep: async () => {} });
    check("a permission 403 is returned, not retried", res.status === 403 && calls.length === 1);
  }
  {
    const { impl, calls } = scripted(() => new Response("", { status: 429 }));
    const res = await googleFetchWithRetry("https://example.test/d", { timeoutMs: 1000, fetchImpl: impl, sleep: async () => {} });
    check("gives up after GOOGLE_MAX_RETRIES retries", res.status === 429 && calls.length === GOOGLE_MAX_RETRIES + 1, `${calls.length} calls`);
  }
  {
    const sleeps: number[] = [];
    const { impl } = scripted((n) => (n === 1 ? new Response("", { status: 429, headers: { "retry-after": "600" } }) : new Response("{}", { status: 200 })));
    await googleFetchWithRetry("https://example.test/e", { timeoutMs: 1000, fetchImpl: impl, sleep: async (ms) => { sleeps.push(ms); } });
    check("a huge Retry-After is capped", sleeps[0] === GOOGLE_MAX_RETRY_DELAY_MS, String(sleeps[0]));
  }

  console.log("fetchGmailHeaders");
  {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/messages/m2")) return new Response('{"error":{"code":401}}', { status: 401 });
      if (url.includes("/messages/m3")) return new Response("", { status: 404 });
      return Response.json({ id: "m1", threadId: "t1", snippet: "hi", payload: { headers: [{ name: "From", value: "a@b.com" }] } });
    }) as typeof fetch;
    let thrown: unknown = null;
    try {
      await fetchGmailHeaders("tok", [{ id: "m1", threadId: "t1" }, { id: "m2", threadId: "t2" }], 1);
    } catch (err) {
      thrown = err;
    }
    check("a 401 rejects with ReauthRequiredError", thrown instanceof ReauthRequiredError, String(thrown));
    const kept = await fetchGmailHeaders("tok", [{ id: "m1", threadId: "t1" }, { id: "m3", threadId: "t3" }], 1);
    check("a 404 is still just dropped", kept.length === 1 && kept[0].id === "m1", JSON.stringify(kept.map((k) => k.id)));
  }

  console.log("People API and profile");
  {
    let peopleCalls = 0;
    const signals: (AbortSignal | null | undefined)[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      signals.push(init?.signal);
      if (url.includes("people.googleapis.com")) {
        peopleCalls++;
        if (peopleCalls === 1) return new Response("", { status: 429 });
        return Response.json({ connections: [{ resourceName: "people/1", names: [{ displayName: "Ada Lovelace" }] }] });
      }
      if (url.includes("oauth2/v2/userinfo")) return Response.json({ email: "ada@example.com" });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const people = await fetchGooglePeopleContacts("tok");
    check("a People 429 is retried", peopleCalls === 2 && people.length === 1, `${peopleCalls} calls, ${people.length} people`);
    const email = await fetchGoogleProfileEmail("tok");
    check("profile email still resolves", email === "ada@example.com");
    check("every Google call carried a timeout signal", signals.every((s) => s instanceof AbortSignal), `${signals.length} calls`);
  }

  console.log("Calendar");
  {
    const { impl, calls } = scripted((n) => (n === 1 ? quota403() : Response.json({ items: [], nextSyncToken: "s" })));
    const page = await fetchCalendarPage({ accessToken: "tok", cursor: null, fetchImpl: impl });
    check("a Calendar quota 403 is retried", calls.length === 2 && page.nextSyncToken === "s", `${calls.length} calls`);
    check("the Calendar call carries a signal", calls[0].signal instanceof AbortSignal);
  }

  globalThis.fetch = realFetch;
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  globalThis.fetch = realFetch;
  console.error(err);
  process.exit(1);
});
