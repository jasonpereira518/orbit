/**
 * Captures bigger than one request (`src/lib/capture/upload-batches.ts`,
 * `uploadCaptureMedia`, and `continueJobId` on `/api/capture/jobs`).
 *
 * Vercel refuses a request body over 4.5MB before any of our code runs, while one capture
 * may be 22MB (twelve scanned pages budget 14.4MB). Before this, anything past 4.5MB failed
 * in production with a generic "Couldn't read that file". A capture now goes up in parts
 * against one job: the first part creates it, later parts extend it, and only the last one
 * moves it to `transcribed`. This drives the real uploader through the real route, with
 * `.txt` files so no model is called.
 *
 * Local PGlite. Run: npx tsx scripts/smoke-capture-upload-parts.ts
 */
import "./smoke/_env";
// The route goes through `requireUserForSurface()`. With no Clerk keys AND
// NODE_ENV=development, that resolves to demo mode's `demo-user`.
delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
delete process.env.CLERK_SECRET_KEY;
(process.env as Record<string, string>).NODE_ENV = "development";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { captureJobs } from "../src/db/schema";
import { POST } from "../src/app/api/capture/jobs/route";
import {
  CAPTURE_BASE64_REQUEST_FILE_BYTES,
  CAPTURE_REQUEST_FILE_BYTES,
  PLATFORM_REQUEST_BODY_MAX_BYTES,
} from "../src/lib/capture-limits";
import { uploadCaptureMedia } from "../src/lib/capture/ingest-client";
import { base64DecodedBytes, planUploadBatches } from "../src/lib/capture/upload-batches";
import { ABANDONED_INGEST_MS, createCaptureJob, getCaptureJobRow, resumeStalledCaptureJobs } from "../src/lib/capture-jobs";

const USER = "demo-user";
const MB = 1024 * 1024;

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

/** A text file of about `bytes`, whose first line names it so order can be checked. */
function textFile(name: string, bytes: number): File {
  const line = `${name} met Ada Lovelace at the demo day.\n`;
  return new File([`${name}\n` + line.repeat(Math.ceil(bytes / line.length))], `${name}.txt`, { type: "text/plain" });
}

const post = (form: FormData) =>
  POST(new Request("http://localhost/api/capture/jobs", { method: "POST", body: form, headers: { "x-orbit-capture": "1" } }));

async function main() {
  console.log("the limits agree with the platform");
  check("a multipart request's files fit under Vercel's 4.5MB with room for the form", CAPTURE_REQUEST_FILE_BYTES + 256 * 1024 < PLATFORM_REQUEST_BODY_MAX_BYTES);
  check("a base64 request's files fit once encoded", Math.ceil((CAPTURE_BASE64_REQUEST_FILE_BYTES * 4) / 3) + 256 * 1024 < PLATFORM_REQUEST_BODY_MAX_BYTES);

  console.log("planning batches");
  const sizes = [1, 2, 2, 5, 1, 3];
  const plan = planUploadBatches(sizes.map((size, i) => ({ i, size })), (x) => x.size, 4);
  check("each batch stays under the limit", plan.batches.every((b) => b.reduce((s, x) => s + x.size, 0) <= 4), JSON.stringify(plan));
  check("order is kept, so pages stay in reading order", plan.batches.flat().map((x) => x.i).join() === "0,1,2,4,5", JSON.stringify(plan));
  check("a file too big for any request is set aside by name", plan.oversized.length === 1 && plan.oversized[0]!.i === 3);
  check("nothing becomes an empty request", planUploadBatches([], (x: number) => x, 4).batches.length === 0);
  const b64 = Buffer.from("x".repeat(1000)).toString("base64");
  check("base64 sizes are measured as the file, not the encoding", base64DecodedBytes(b64) === 1000, String(base64DecodedBytes(b64)));

  console.log("the route, part by part");
  const db = await getDb();
  await db.delete(captureJobs).where(eq(captureJobs.userId, USER));
  const first = new FormData();
  first.set("sourceKind", "messy");
  first.set("final", "0");
  first.append("files", textFile("alpha", 1000), "alpha.txt");
  const r1 = await post(first);
  const b1 = (await r1.json()) as { job?: { id: string; status: string } };
  check("a first part that is not final leaves the job collecting", r1.status === 200 && b1.job?.status === "ingesting", JSON.stringify(b1));
  const jobId = b1.job!.id;

  const second = new FormData();
  second.set("sourceKind", "messy");
  second.set("continueJobId", jobId);
  second.append("files", textFile("beta", 1000), "beta.txt");
  const r2 = await post(second);
  const b2 = (await r2.json()) as { job?: { id: string; status: string } };
  check("the final part finishes the SAME job", r2.status === 200 && b2.job?.id === jobId && b2.job.status === "transcribed", JSON.stringify(b2));
  const row = await getCaptureJobRow(USER, jobId);
  const blocks = (row?.ingestedBlocks ?? []) as Array<{ text: string }>;
  check("with both parts' text, in order", blocks.length === 2 && blocks[0]!.text.startsWith("alpha") && blocks[1]!.text.startsWith("beta"), JSON.stringify(blocks.map((b) => b.text.slice(0, 10))));

  const late = new FormData();
  late.set("sourceKind", "messy");
  late.set("continueJobId", jobId);
  late.append("files", textFile("gamma", 100), "gamma.txt");
  check("a part for a job that is already finished is refused", (await post(late)).status === 409);

  const foreign = await createCaptureJob("someone-else", { sourceKind: "messy", status: "ingesting" });
  const forged = new FormData();
  forged.set("sourceKind", "messy");
  forged.set("continueJobId", foreign.id);
  forged.append("files", textFile("delta", 100), "delta.txt");
  check("a part naming another user's job is refused", (await post(forged)).status === 409);
  check("and that job is untouched", ((await getCaptureJobRow("someone-else", foreign.id))?.ingestedBlocks ?? []).length === 0);

  console.log("the uploader, over the limit");
  const realFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests++;
    const body = init?.body as FormData;
    const bytes = body.getAll("files").reduce((s, f) => s + (f as File).size, 0);
    // What Vercel would do to anything bigger.
    if (bytes > PLATFORM_REQUEST_BODY_MAX_BYTES) return new Response("Request Entity Too Large", { status: 413 });
    return POST(new Request(`http://localhost${url}`, init));
  }) as typeof fetch;
  const res = await uploadCaptureMedia({
    sourceKind: "messy",
    files: [textFile("one", 1.5 * MB), textFile("two", 1.5 * MB), textFile("three", 1.5 * MB)],
  });
  globalThis.fetch = realFetch;
  check("4.5MB of files goes up in more than one request", requests === 2, `${requests} requests`);
  check("and comes back as one transcribed capture", res.ok && res.job.status === "transcribed", JSON.stringify(res.ok ? res.job.status : res));
  if (res.ok) {
    const order = ["one", "two", "three"].map((n) => res.text.indexOf(`${n}\n`));
    check("with every file's text, in the order picked", order.every((i) => i >= 0) && order[0]! < order[1]! && order[1]! < order[2]!, JSON.stringify(order));
    const parts = await db.select().from(captureJobs).where(eq(captureJobs.userId, USER));
    check("as one job, not one per request", parts.filter((j) => j.status === "transcribed").length === 2, `${parts.length} jobs`);
  }

  const huge = await uploadCaptureMedia({ sourceKind: "messy", files: [textFile("huge", CAPTURE_REQUEST_FILE_BYTES + MB)] });
  check("one file bigger than a request is refused by name, before sending", !huge.ok && huge.status === 413 && huge.error.includes("huge.txt"), JSON.stringify(huge));

  console.log("an upload abandoned part-way");
  const stranded = await createCaptureJob(USER, { sourceKind: "messy", status: "ingesting" });
  const phone = await createCaptureJob(USER, { sourceKind: "phone", status: "ingesting" });
  const old = new Date(Date.now() - ABANDONED_INGEST_MS - 60_000);
  await db.update(captureJobs).set({ updatedAt: old }).where(eq(captureJobs.id, stranded.id));
  await db.update(captureJobs).set({ updatedAt: old }).where(eq(captureJobs.id, phone.id));
  const sweep = await resumeStalledCaptureJobs({ runner: async () => {} });
  check("is closed as failed by the hourly sweep", (await getCaptureJobRow(USER, stranded.id))?.status === "failed" && sweep.abandoned >= 1, JSON.stringify(sweep));
  check("while a phone scan, which has its own expiry, is left alone", (await getCaptureJobRow(USER, phone.id))?.status === "ingesting");

  await db.delete(captureJobs).where(eq(captureJobs.userId, USER));
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll capture upload-parts checks passed");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
