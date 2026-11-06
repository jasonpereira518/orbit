/**
 * A duplicate upload is not read again (`/api/capture/jobs` with `autoQueue`, the path the
 * notes library and the folder sorter take).
 *
 * The browser's byte hash catches the SAME FILE dropped twice. It cannot catch a different
 * file with the same words in it — a re-saved doc, a re-exported PDF — and until now that one
 * went to the model a second time. The route now hashes the text it just transcribed
 * (`hashSourceNote`, the stamp every extracted job carries) and, finding an earlier capture,
 * drops the new job BEFORE queueing it and says so. Drives the real route with `.txt` files, so
 * no model is called either way: a queued job would be read by `after()`, which is why the
 * only non-duplicate request here leaves `autoQueue` off.
 *
 * Local PGlite. Run: npx tsx scripts/smoke-capture-duplicate-upload.ts
 */
import "./smoke/_env";
// With no Clerk keys AND NODE_ENV=development the route resolves to demo mode's `demo-user`.
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
(process.env as Record<string, string>).NODE_ENV = "development";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { captureJobs, noteBatches } from "../src/db/schema";
import { POST } from "../src/app/api/capture/jobs/route";
import { createCaptureJob, getCaptureJobRow } from "../src/lib/capture-jobs";
import { emptyNoteBatchResult } from "../src/lib/note-batches";
import { hashSourceNote } from "../src/lib/suggested-reminder-utils";
import { run } from "./smoke/_env";

const USER = "demo-user";
const TEXT = "Coffee with Priya Raman about the pilot pricing. She will send the deck by Friday.";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const file = (name: string, body: string) => new File([body], name, { type: "text/plain" });

function upload(f: File, extra: Record<string, string> = {}) {
  const form = new FormData();
  form.set("sourceKind", "messy");
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  form.append("files", f, f.name);
  return POST(new Request("http://localhost/api/capture/jobs", { method: "POST", body: form, headers: { "x-orbit-capture": "1" } }));
}

type Body = {
  ok?: boolean;
  duplicate?: { jobId: string | null; capturedAt: string };
  job?: { id: string; status: string };
};

async function reset() {
  const db = await getDb();
  await db.delete(captureJobs).where(eq(captureJobs.userId, USER));
  await db.delete(noteBatches).where(eq(noteBatches.userId, USER));
}

async function main() {
  await reset();
  const db = await getDb();

  console.log("an earlier extraction of the same words");
  const earlier = await createCaptureJob(USER, { sourceKind: "messy", status: "queued", inputText: TEXT });
  // As the runner leaves a job once it has read it: extracted, hash stamped, awaiting review.
  await db.update(captureJobs).set({ status: "ready", sourceHash: hashSourceNote(TEXT) }).where(eq(captureJobs.id, earlier.id));

  // A DIFFERENT file (name, bytes, spacing, case) carrying the same words.
  const res = await upload(file("renamed-notes.txt", `\n  ${TEXT.toUpperCase()}  \n`), { autoQueue: "1" });
  const body = (await res.json()) as Body;
  check("the upload succeeds, and says it was a duplicate", res.status === 200 && body.ok === true && Boolean(body.duplicate), JSON.stringify(body));
  check("it names the earlier capture", body.duplicate?.jobId === earlier.id, JSON.stringify(body.duplicate));
  check("and when", typeof body.duplicate?.capturedAt === "string" && !Number.isNaN(Date.parse(body.duplicate.capturedAt)));
  const dropped = body.job ? await getCaptureJobRow(USER, body.job.id) : null;
  check("the new job was dropped, not queued", dropped?.status === "discarded", dropped?.status);
  check(
    "so nothing is waiting to be read",
    (await db.query.captureJobs.findMany({ where: eq(captureJobs.userId, USER) })).filter(
      (j) => j.status === "queued" || j.status === "extracting"
    ).length === 0
  );
  check("the earlier capture is untouched", (await getCaptureJobRow(USER, earlier.id))?.status === "ready");

  console.log("\na capture saved with no job behind it");
  await db.update(captureJobs).set({ sourceHash: null }).where(eq(captureJobs.id, earlier.id));
  const other = "Lunch with Marcus Lee; he is intro-ing me to the Acme CTO.";
  await db.insert(noteBatches).values({
    userId: USER,
    sourceHash: hashSourceNote(other),
    sourceText: other,
    anchorDate: new Date(),
    result: emptyNoteBatchResult(),
  });
  const viaBatch = (await (await upload(file("lunch.txt", other), { autoQueue: "1" })).json()) as Body;
  check("a saved batch counts too", Boolean(viaBatch.duplicate) && viaBatch.duplicate?.jobId === null, JSON.stringify(viaBatch));
  await db.update(noteBatches).set({ status: "undone" }).where(eq(noteBatches.userId, USER));

  console.log("\nwhat must still go through");
  await db.update(captureJobs).set({ sourceHash: hashSourceNote(TEXT) }).where(eq(captureJobs.id, earlier.id));
  // Not auto-queued: the single-capture flow reads in a separate, gated step (`queueCaptureJob`)
  // and has an edit step in between, so the upload itself is never refused.
  const plain = (await (await upload(file("again.txt", TEXT))).json()) as Body;
  check("an upload that is not auto-queued is never refused as a duplicate", !plain.duplicate && plain.job?.status === "transcribed", JSON.stringify(plain));
  const undone = (await (await upload(file("undone.txt", other))).json()) as Body;
  check("a capture that was undone does not block its notes", !undone.duplicate);

  await reset();
  console.log(failures ? `\n${failures} check(s) failed` : "\nsmoke-capture-duplicate-upload: all checks passed");
  if (failures) process.exit(1);
}

run(main);
