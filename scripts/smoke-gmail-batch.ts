/**
 * Exercises batched thread retrieval against a stubbed Gmail.
 *
 * The multipart encoding and its parsing are the fiddliest code in the scan and the easiest
 * to get subtly wrong — a response paired to the wrong request produces plausible, entirely
 * incorrect data rather than an error. These checks pin the parts that would fail silently:
 * the Content-ID join, chunking, and every fallback path.
 *
 * No network — `globalThis.fetch` is replaced for the duration.
 *
 * Run: npx tsx scripts/smoke-gmail-batch.ts
 */
import { fetchGmailThreadsBatched } from "../src/lib/gmail";

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    return;
  }
  console.log(`  ok    ${label}`);
}

type Call = { url: string; body: string; method: string };

function threadJson(id: string, extra: Record<string, unknown> = {}) {
  const json = JSON.stringify({
    id,
    messages: [
      {
        id: `${id}-m2`,
        threadId: id,
        internalDate: "2000",
        snippet: `second in ${id}`,
        payload: { headers: [{ name: "From", value: `b@${id}.com` }] },
      },
      {
        id: `${id}-m1`,
        threadId: id,
        internalDate: "1000",
        snippet: `first in ${id}`,
        payload: { headers: [{ name: "From", value: `a@${id}.com` }] },
      },
    ],
    ...extra,
  });
  // Insert a genuine blank line into the body. JSON escapes newlines inside strings, so the
  // only way a real one appears is as inter-token whitespace — which is legal JSON, and which
  // truncates the body if the part is split on a blank line and not rejoined.
  return json.replace(`"messages"`, `\r\n\r\n"messages"`);
}

function batchResponse(ids: string[], boundary = "resp_boundary"): Response {
  const parts = ids
    .map((id) =>
      [
        `--${boundary}`,
        "Content-Type: application/http",
        `Content-ID: <response-${id}>`,
        "",
        "HTTP/1.1 200 OK",
        "Content-Type: application/json; charset=UTF-8",
        "",
        threadJson(id),
        "",
      ].join("\r\n")
    )
    .join("");
  return new Response(`${parts}--${boundary}--`, {
    status: 200,
    headers: { "Content-Type": `multipart/mixed; boundary=${boundary}` },
  });
}

function install(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      body: String(init?.body ?? ""),
      method: init?.method ?? "GET",
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}

const realFetch = globalThis.fetch;

async function main() {
  console.log("\nhappy path");
  let calls = install((c) => {
    const ids = [...c.body.matchAll(/threads\/([^?]+)\?/g)].map((m) => m[1]);
    // Returned deliberately out of order: pairing by position would mis-associate.
    return batchResponse([...ids].reverse());
  });
  let threads = await fetchGmailThreadsBatched("tok", ["ta", "tb", "tc"]);
  check("one HTTP call for three threads", calls.length === 1, `${calls.length} calls`);
  check("posts to the Gmail batch endpoint", calls[0].url === "https://gmail.googleapis.com/batch/gmail/v1", calls[0].url);
  check("uses POST", calls[0].method === "POST");
  check("all three threads returned", threads.length === 3, `${threads.length}`);
  check(
    "responses are joined by Content-ID, not order",
    threads.every((t) => t.messages.every((m) => m.threadId === t.id)),
    JSON.stringify(threads.map((t) => [t.id, t.messages.map((m) => m.threadId)]))
  );
  check(
    "messages are sorted oldest first",
    threads.every((t) => (t.messages[0].internalDate ?? 0) < (t.messages[1].internalDate ?? 0))
  );
  check(
    "a body containing a blank line is not truncated",
    threads.length === 3 && threads.every((t) => t.messages.length === 2),
    JSON.stringify(threads.map((t) => t.messages.length))
  );
  check("headers are parsed out of the payload", threads.every((t) => t.messages[0].from.startsWith("a@")));

  console.log("\nchunking");
  calls = install((c) => {
    const ids = [...c.body.matchAll(/threads\/([^?]+)\?/g)].map((m) => m[1]);
    check(`  batch of ${ids.length} is within Google's recommended 50`, ids.length <= 50);
    return batchResponse(ids);
  });
  threads = await fetchGmailThreadsBatched("tok", Array.from({ length: 120 }, (_, i) => `t${i}`));
  check("120 threads split into 3 batches", calls.length === 3, `${calls.length}`);
  check("all 120 returned", threads.length === 120, `${threads.length}`);

  console.log("\nfallbacks");
  calls = install((c) => {
    if (c.url.includes("/batch/")) {
      const ids = [...c.body.matchAll(/threads\/([^?]+)\?/g)].map((m) => m[1]);
      // Drop one part, as a partial batch failure would.
      return batchResponse(ids.filter((id) => id !== "tb"));
    }
    const id = c.url.match(/threads\/([^?]+)\?/)?.[1] ?? "";
    return new Response(threadJson(id), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  threads = await fetchGmailThreadsBatched("tok", ["ta", "tb", "tc"]);
  check("a dropped part is retried individually", threads.length === 3, `${threads.length}`);
  check("the retry is a single-thread GET", calls.some((c) => !c.url.includes("/batch/") && c.url.includes("threads/tb")));
  check("only the missing thread is retried", calls.filter((c) => !c.url.includes("/batch/")).length === 1);

  calls = install((c) => {
    if (c.url.includes("/batch/")) return new Response("nope", { status: 503 });
    const id = c.url.match(/threads\/([^?]+)\?/)?.[1] ?? "";
    return new Response(threadJson(id), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  threads = await fetchGmailThreadsBatched("tok", ["ta", "tb"]);
  check("a refused batch degrades to individual GETs, not an error", threads.length === 2, `${threads.length}`);

  calls = install(() =>
    // Malformed: no boundary on the response content type.
    new Response("garbage", { status: 200, headers: { "Content-Type": "multipart/mixed" } })
  );
  threads = await fetchGmailThreadsBatched("tok", []);
  check("an empty id list makes no HTTP call at all", calls.length === 0 && threads.length === 0);

  console.log("\nnon-2xx sub-responses are dropped, not parsed");
  install(() =>
    new Response(
      [
        "--b",
        "Content-Type: application/http",
        "Content-ID: <response-ta>",
        "",
        "HTTP/1.1 404 Not Found",
        "Content-Type: application/json",
        "",
        '{"error":"gone"}',
        "",
        "--b--",
      ].join("\r\n"),
      { status: 200, headers: { "Content-Type": "multipart/mixed; boundary=b" } }
    )
  );
  threads = await fetchGmailThreadsBatched("tok", ["ta"]);
  check("a 404 sub-response yields no thread", threads.length === 0, JSON.stringify(threads));

  console.log("\nrequest shape");
  calls = install((c) => batchResponse([...c.body.matchAll(/threads\/([^?]+)\?/g)].map((m) => m[1])));
  await fetchGmailThreadsBatched("tok", ["ta"]);
  const body = calls[0].body;
  check("declares application/http parts", body.includes("Content-Type: application/http"));
  check("echoes a Content-ID per sub-request", body.includes("Content-ID: <ta>"));
  check("requests metadata format only", body.includes("format=metadata"));
  check("asks for the bulk-mail headers triage needs", body.includes("metadataHeaders=List-Unsubscribe"));
  check("terminates the multipart body", body.trimEnd().endsWith("--"));
}

main()
  .then(() => {
    globalThis.fetch = realFetch;
    if (failures > 0) {
      console.log(`\n${failures} batch check(s) failed`);
      process.exit(1);
    }
    console.log("\nall gmail batch checks passed");
    process.exit(0);
  })
  .catch((err) => {
    globalThis.fetch = realFetch;
    console.error(err);
    process.exit(1);
  });
