/**
 * Offline and poor-network behaviour: the connectivity state machine, the probe backoff,
 * what counts as a network failure, and what the chat stream client says when the
 * connection fails before, during, or at the end of an answer.
 *
 * Pure — the reducer takes events and the clock, and `streamChat` runs against a stubbed
 * `fetch`. No browser, no database, no network.
 *
 * Run: npx tsx scripts/smoke-connectivity.ts
 */
import {
  INITIAL_CONNECTIVITY,
  PROBE_BASE_MS,
  PROBE_MAX_MS,
  initialConnectivity,
  isReconnection,
  nextProbeDelay,
  reduceConnectivity,
  type ConnectivityEvent,
  type ConnectivityState,
} from "../src/lib/connectivity";
import { OFFLINE_MESSAGE, friendlyError, isNetworkError } from "../src/lib/errors";
import {
  CHAT_CUT_OFF_MESSAGE,
  CHAT_DROPPED_MESSAGE,
  CHAT_FAILED_MESSAGE,
  streamChat,
} from "../src/lib/chat-stream-client";
import { formatSse } from "../src/lib/chat-stream-protocol";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

function run(events: ConnectivityEvent[], from: ConnectivityState = INITIAL_CONNECTIVITY) {
  return events.reduce(reduceConnectivity, from);
}

async function main() {
  console.log("Connectivity state");
  {
    check("starts online when the browser says so", initialConnectivity(true, 1).status === "online");
    const off = initialConnectivity(false, 5);
    check("starts offline when the browser says so, remembering when", off.status === "offline" && off.lostAt === 5);

    const s = run([{ type: "browser_offline", at: 10 }]);
    check("the browser going offline is believed at once", s.status === "offline" && s.lostAt === 10);

    const back = run([{ type: "browser_offline", at: 10 }, { type: "browser_online" }]);
    check(
      "an interface coming back is not yet 'online' — it waits for Orbit to answer",
      back.status === "unreachable",
      back.status
    );
    check("  and does not forget when the outage began", back.lostAt === 10);

    const answered = reduceConnectivity(back, { type: "probe_ok" });
    check("a probe that gets an answer is 'online'", answered.status === "online" && answered.lostAt === null);
    check("  which is a reconnection", isReconnection(back.status, answered.status));

    const flaky = run([
      { type: "probe_failed", at: 20 },
      { type: "probe_failed", at: 22 },
    ]);
    check("failed probes while 'online' mean unreachable", flaky.status === "unreachable");
    check("  counting failures for the backoff", flaky.failedProbes === 2);
    check("  from the first failure", flaky.lostAt === 20);

    const recovered = reduceConnectivity(flaky, { type: "request_ok" });
    check("real traffic getting through clears unreachable without a probe", recovered.status === "online");

    const stale = reduceConnectivity(s, { type: "request_ok" });
    check(
      "a late success does not override the browser saying it is offline",
      stale.status === "offline"
    );
    check(
      "  nor does a probe failure turn 'offline' into 'unreachable'",
      reduceConnectivity(s, { type: "probe_failed", at: 11 }).status === "offline"
    );
    check(
      "an ok while already online changes nothing (no re-render, no reconnect event)",
      reduceConnectivity(INITIAL_CONNECTIVITY, { type: "probe_ok" }) === INITIAL_CONNECTIVITY
    );
    check("online → online is not a reconnection", !isReconnection("online", "online"));
    check("online → offline is not a reconnection", !isReconnection("online", "offline"));
  }

  console.log("\nProbe backoff");
  {
    const mid = () => 0.5; // no jitter
    const delays = [1, 2, 3, 4, 5, 6, 10].map((n) => nextProbeDelay(n, mid));
    check("doubles from the base", delays[0] === PROBE_BASE_MS && delays[1] === PROBE_BASE_MS * 2, delays.join(","));
    check("caps at the max", delays.slice(4).every((d) => d === PROBE_MAX_MS), delays.join(","));
    check("never exceeds the max even with jitter", nextProbeDelay(20, () => 1) <= PROBE_MAX_MS);
    const low = nextProbeDelay(1, () => 0);
    const high = nextProbeDelay(1, () => 0.999);
    check("jitters ±20% so tabs do not probe in lockstep", low < PROBE_BASE_MS && high > PROBE_BASE_MS, `${low}..${high}`);
    check("a zero count behaves like the first retry", nextProbeDelay(0, mid) === PROBE_BASE_MS);
  }

  console.log("\nWhat counts as a network failure");
  {
    check("Chrome's fetch failure", isNetworkError(new TypeError("Failed to fetch")));
    check("Firefox's", isNetworkError(new TypeError("NetworkError when attempting to fetch resource.")));
    check("Safari's", isNetworkError(new TypeError("Load failed")));
    check("Safari's dropped connection", isNetworkError(new TypeError("The network connection was lost.")));
    check("a plain Error with the same words is NOT one", !isNetworkError(new Error("Failed to fetch")));
    check("an unrelated TypeError is not one", !isNetworkError(new TypeError("x is not a function")));
    check("friendlyError still says offline for one", friendlyError(new TypeError("Failed to fetch"), "fallback") === OFFLINE_MESSAGE);
  }

  console.log("\nChat stream on a bad connection");
  {
    const realFetch = globalThis.fetch;
    const streamOf = (input: string[], opts: { failAfter?: boolean } = {}) => {
      const frames = [...input];
      return new Response(
        // Pull-based, one frame per read: `controller.error()` throws away anything still
        // queued, so erroring in `start` would drop the frames before the reader saw them.
        new ReadableStream<Uint8Array>({
          pull(controller) {
            const next = frames.shift();
            if (next !== undefined) controller.enqueue(new TextEncoder().encode(next));
            else if (opts.failAfter) controller.error(new TypeError("network error"));
            else controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    };

    async function ask(fake: () => Promise<Response>) {
      globalThis.fetch = fake as typeof fetch;
      const errors: string[] = [];
      let answer = "";
      let done = false;
      try {
        await streamChat(
          { question: "who do I know at Acme?" },
          {
            onAnswer: (d) => void (answer += d),
            onRecommendations: () => {},
            onDone: () => void (done = true),
            onError: (m) => void errors.push(m),
          }
        );
      } finally {
        globalThis.fetch = realFetch;
      }
      return { errors, answer, done };
    }

    const unreachable = await ask(() => Promise.reject(new TypeError("Failed to fetch")));
    check(
      "no connection at all reads as offline, not 'Failed to fetch'",
      unreachable.errors.length === 1 && unreachable.errors[0] === OFFLINE_MESSAGE,
      JSON.stringify(unreachable.errors)
    );

    const bare500 = await ask(() => Promise.resolve(new Response("oops", { status: 500 })));
    check(
      "a bare 500 gets house copy, not a status code",
      bare500.errors[0] === CHAT_FAILED_MESSAGE,
      JSON.stringify(bare500.errors)
    );

    const dropped = await ask(() =>
      Promise.resolve(streamOf([formatSse({ type: "answer", delta: "Ada works " })], { failAfter: true }))
    );
    check(
      "a connection dropped mid-answer says so",
      dropped.errors.length === 1 && dropped.errors[0] === CHAT_DROPPED_MESSAGE,
      JSON.stringify(dropped.errors)
    );
    check("  after delivering what did arrive", dropped.answer === "Ada works ");

    const cut = await ask(() => Promise.resolve(streamOf([formatSse({ type: "answer", delta: "Ada" })])));
    check(
      "a stream that closes without `done` is reported as cut off, not passed off as whole",
      cut.errors.length === 1 && cut.errors[0] === CHAT_CUT_OFF_MESSAGE && !cut.done,
      JSON.stringify(cut.errors)
    );

    const whole = await ask(() =>
      Promise.resolve(
        streamOf([
          formatSse({ type: "answer", delta: "Ada." }),
          formatSse({ type: "done", messageId: "m1", title: null, retrieved: 0 } as never),
        ])
      )
    );
    check("a finished answer reports no error", whole.errors.length === 0 && whole.done, JSON.stringify(whole.errors));

    const doneThenDrop = await ask(() =>
      Promise.resolve(
        streamOf([formatSse({ type: "done", messageId: "m1", title: null, retrieved: 0 } as never)], {
          failAfter: true,
        })
      )
    );
    check(
      "a drop AFTER `done` is not an error — the answer is already whole",
      doneThenDrop.errors.length === 0 && doneThenDrop.done,
      JSON.stringify(doneThenDrop.errors)
    );
  }

  console.log("\nsmoke-connectivity: all checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
