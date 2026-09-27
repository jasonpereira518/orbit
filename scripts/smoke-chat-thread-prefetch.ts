/**
 * The chat history prefetcher's freshness rules (`src/lib/chat-thread-prefetch.ts`): a read
 * taken within `freshMs` is the thread; an older one is handed back marked stale, to show
 * while the panel re-reads; past `keepMs` it is not shown at all; a wrong-thread result is
 * never kept; and a failed re-read leaves the older read usable rather than nothing.
 *
 * A fake clock and a hand-driven fetcher, no timers and no server. Run:
 *   npx tsx scripts/smoke-chat-thread-prefetch.ts
 */
import { createThreadPrefetcher } from "../src/lib/chat-thread-prefetch";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Read = { thread: { id: string }; rev: number };

function harness() {
  let t = 0;
  const calls: { id: string; resolve: (v: Read) => void; reject: (e: unknown) => void }[] = [];
  const p = createThreadPrefetcher<Read>(
    (id) => new Promise<Read>((resolve, reject) => calls.push({ id, resolve, reject })),
    { freshMs: 2_000, keepMs: 60_000, delayMs: 0, now: () => t }
  );
  return {
    p,
    calls,
    advance: (ms: number) => (t += ms),
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

async function main() {
  {
    const { p, calls, advance } = harness();
    p.prefetch("a");
    calls[0].resolve({ thread: { id: "a" }, rev: 1 });
    await tick();
    advance(500);
    const taken = p.take("a");
    check("a read inside freshMs is taken as the thread", !!taken && "value" in taken && taken.fresh === true);
    check("an entry is used once", p.take("a") === null);
  }
  {
    const { p, calls, advance } = harness();
    p.prefetch("a");
    calls[0].resolve({ thread: { id: "a" }, rev: 1 });
    await tick();
    advance(10_000);
    const taken = p.take("a");
    check(
      "an older read comes back marked stale, to show while re-reading",
      !!taken && "value" in taken && taken.fresh === false && taken.value.rev === 1
    );
  }
  {
    const { p, calls, advance } = harness();
    p.prefetch("a");
    calls[0].resolve({ thread: { id: "a" }, rev: 1 });
    await tick();
    advance(61_000);
    check("past keepMs a read is not shown at all", p.take("a") === null);
  }
  {
    const { p, calls, advance } = harness();
    p.prefetch("a");
    calls[0].resolve({ thread: { id: "a" }, rev: 1 });
    await tick();
    advance(10_000);
    p.prefetch("a");
    check("hovering a stale entry reads the thread again", calls.length === 2);
    const taken = p.take("a");
    check(
      "while that re-read runs, the older read shows with the re-read to wait on",
      !!taken && "value" in taken && taken.fresh === false && taken.value.rev === 1 && !!taken.promise
    );
    calls[1].resolve({ thread: { id: "a" }, rev: 2 });
    const current = taken && "promise" in taken ? await taken.promise : null;
    check("the re-read resolves to the current thread", current?.rev === 2);
  }
  {
    const { p, calls, advance } = harness();
    p.prefetch("a");
    calls[0].resolve({ thread: { id: "a" }, rev: 1 });
    await tick();
    advance(10_000);
    p.prefetch("a");
    calls[1].reject(new Error("offline"));
    await tick();
    await tick();
    const taken = p.take("a");
    check(
      "a failed re-read leaves the older read usable, still marked stale",
      !!taken && "value" in taken && taken.fresh === false && taken.value.rev === 1
    );
  }
  {
    const { p, calls } = harness();
    p.prefetch("a");
    calls[0].resolve({ thread: { id: "b" }, rev: 1 });
    await tick();
    await tick();
    check("a result for another thread is never kept", p.take("a") === null);
  }
  {
    const { p, calls, advance } = harness();
    p.prefetch("a");
    advance(300);
    const taken = p.take("a");
    check("a read still in flight is handed over to await", !!taken && "promise" in taken && !("value" in taken));
    calls[0].resolve({ thread: { id: "a" }, rev: 1 });
  }

  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nChat thread prefetch checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
