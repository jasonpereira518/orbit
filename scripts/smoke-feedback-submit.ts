/**
 * Feedback submission storage smoke tests.
 *
 * Exercises `src/lib/feedback-submission.ts` rather than `src/actions/feedback.ts`, for the
 * same reason `scripts/smoke-admin-actions.ts` exercises `admin-operations.ts`: a
 * `"use server"` export cannot run outside a request, so the guards inside one would be
 * untestable. The action is a thin wrapper over what is checked here.
 *
 * The important cases: an unprovisioned Blob store must still store the picture somewhere
 * durable (that is the configuration Orbit is actually in today), per-shot notes must
 * survive in order, and the input schema must DROP anything the client sends that the
 * server means to stamp itself.
 *
 * Run: npx tsx scripts/smoke-feedback-submit.ts
 */
import "./smoke/_env";

import { asc, eq, like } from "drizzle-orm";
import { getDb } from "../src/db";
import { feedback, feedbackScreenshots } from "../src/db/schema";
import { recordFeedback } from "../src/lib/feedback";
import {
  createFeedbackSubmission,
  decodeScreenshot,
  feedbackSubmissionSchema,
} from "../src/lib/feedback-submission";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "../src/lib/rate-limit";

const USER = "smoke-feedback-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const PIXEL_WEBP = "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAQAcJaQAA3AA/vuUAAA=";
const WEBP_DATA_URL = `data:image/webp;base64,${PIXEL_WEBP}`;

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

async function cleanup() {
  const db = await getDb();
  await db.delete(feedbackScreenshots).where(eq(feedbackScreenshots.userId, USER));
  await db.delete(feedback).where(eq(feedback.userId, USER));
}

async function main() {
  console.log("Feedback submission\n");
  await cleanup();
  const db = await getDb();

  // The schema is the barrier between the client and `context`. Anything the server means
  // to stamp itself has to be dropped HERE, before the action ever builds the object —
  // otherwise a spread of validated input would quietly reinstate a spoofed plan.
  const hostile = feedbackSubmissionSchema.parse({
    text: "the graph is slow",
    userId: "someone-else",
    plan: "lifetime",
    ip: "10.0.0.1",
    serverRoute: "/admin",
    commit: "deadbee",
  } as never);
  for (const key of ["userId", "plan", "ip", "serverRoute", "commit"]) {
    check(`the schema drops a client-supplied \`${key}\``, !(key in hostile));
  }

  const decoded = decodeScreenshot(WEBP_DATA_URL);
  check("the fixture screenshot decodes", decoded !== null);

  // The configuration Orbit is in today: no Blob store provisioned. The picture still has
  // to land somewhere durable rather than being dropped.
  await withEnv(
    { BLOB_READ_WRITE_TOKEN: undefined, BLOB_STORE_ID: undefined, VERCEL_OIDC_TOKEN: undefined },
    async () => {
      const created = await createFeedbackSubmission({
        userId: USER,
        text: "the graph is slow on a big network",
        area: "graph",
        category: "bug",
        context: { plan: "free", route: "/graph" },
        screenshots: [
          { ...decoded!, note: "this bit takes seconds", width: 1, height: 1 },
          { ...decoded!, note: "and this is after", width: 1, height: 1 },
        ],
      });
      check("the submission returns an id", Boolean(created.id));
      check("both screenshots were stored", created.screenshotCount === 2);

      const [entry] = await db.select().from(feedback).where(eq(feedback.id, created.id));
      check("kind is freeform", entry.kind === "freeform");
      check("area round-trips", entry.area === "graph");
      check("category round-trips", entry.category === "bug");
      check("status defaults to new", entry.status === "new");
      check("status_changed_at starts null", entry.statusChangedAt === null);
      check("the server-built context is stored verbatim", entry.context.route === "/graph");

      const shots = await db
        .select()
        .from(feedbackScreenshots)
        .where(eq(feedbackScreenshots.feedbackId, created.id))
        .orderBy(asc(feedbackScreenshots.position));

      check("shots come back in attachment order", shots.map((s) => s.position).join() === "0,1");
      check(
        "per-shot notes round-trip against the right shot",
        shots[0].note === "this bit takes seconds" && shots[1].note === "and this is after"
      );
      check("storage is inline without a Blob store", shots.every((s) => s.storage === "inline"));
      check("...so blob_url is null", shots.every((s) => s.blobUrl === null));
      check("...and the bytes are there", shots[0].inlineData === PIXEL_WEBP);
      check("the content type is the sniffed one", shots[0].contentType === "image/webp");
      check("byte size is the DECODED length", shots[0].byteSize === decoded!.buf.byteLength);
      check("the shot carries its own user_id for the purge sweep", shots[0].userId === USER);
    }
  );

  // A row written the old way — the fire-and-forget PMF/churn path — must show up in the
  // console like everything else rather than sitting outside the triage filters forever.
  await recordFeedback({ userId: USER, kind: "pmf", score: 3 });
  const [pmf] = await db
    .select()
    .from(feedback)
    .where(eq(feedback.kind, "pmf"))
    .orderBy(asc(feedback.createdAt));
  check("a recordFeedback row also defaults to status=new", pmf.status === "new");

  // Rate limiting: the sixth call in the window is refused.
  let refused = false;
  for (let i = 0; i < 6; i += 1) {
    try {
      await consumeBucket("feedback", `${USER}-rl`, RATE_LIMITS.feedback);
    } catch (err) {
      refused = isRateLimitedError(err) && i === 5;
    }
  }
  check("the sixth submission in the window is rate limited", refused);

  await cleanup();
  const leftover = await db
    .select()
    .from(feedbackScreenshots)
    .where(like(feedbackScreenshots.userId, "smoke-feedback%"));
  check("cleanup left nothing behind", leftover.length === 0);

  console.log("\nAll feedback submission checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
