/**
 * Exercises the apply path: company merging, stage monotonicity, the hybrid write policy,
 * and idempotency under re-scan.
 *
 * These are the assertions that protect a user's CRM from a misfiring classifier. The
 * idempotency checks matter most — an incremental scan re-reads overlapping mail by design,
 * so a write path that is not idempotent multiplies a pipeline instead of updating it.
 *
 * Writes rows under clearly-namespaced synthetic user ids and removes them in a finally
 * block. Do NOT run this while `next dev` holds `.data/pglite` — PGlite is single-writer and
 * the writes will be silently lost.
 *
 * Run: npx tsx scripts/smoke-recruiter-pipeline.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../src/db";
import {
  recruiterOpportunities,
  recruiterScanFindings,
  recruiterScanVerdicts,
  recruiterThreads,
  recruiters,
  userRecruiterLinks,
} from "../src/db/schema";
import {
  applyThreadFinding,
  loadVerdicts,
  normalizeOpportunityCompany,
  recordFinding,
  recordVerdict,
  type ThreadFinding,
} from "../src/lib/recruiter-opportunities";

const USER = "smoke-pipeline-user";
let failures = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    return;
  }
  console.log(`  ok    ${label}`);
}

const d = (day: number) => new Date(Date.UTC(2026, 5, day));

function finding(over: Partial<ThreadFinding> = {}): ThreadFinding {
  return {
    gmailThreadId: "t-default",
    subject: "Opportunity",
    senderKind: "human",
    direction: "inbound",
    correspondentEmail: "sarah@stripe.com",
    correspondentName: "Sarah Chen",
    recruiterFirm: "Stripe",
    hiringCompany: "Stripe",
    roles: ["Backend Engineer"],
    stage: "outreach_received",
    stageEvidence: "we have an opening",
    summary: "Sarah reached out about a backend role.",
    nextStep: "Reply with availability",
    confidence: 0.9,
    messageCount: 2,
    userReplied: true,
    firstMessageAt: d(1),
    lastMessageAt: d(1),
    ...over,
  };
}

async function cleanup() {
  const db = await getDb();
  await db.delete(recruiterScanFindings).where(eq(recruiterScanFindings.userId, USER));
  await db.delete(recruiterThreads).where(eq(recruiterThreads.userId, USER));
  await db.delete(recruiterOpportunities).where(eq(recruiterOpportunities.userId, USER));
  await db.delete(recruiterScanVerdicts).where(eq(recruiterScanVerdicts.userId, USER));
  const links = await db.query.userRecruiterLinks.findMany({
    where: eq(userRecruiterLinks.userId, USER),
    columns: { recruiterId: true },
  });
  await db.delete(userRecruiterLinks).where(eq(userRecruiterLinks.userId, USER));
  const ids = [...new Set(links.map((l) => l.recruiterId))];
  if (ids.length > 0) {
    await db.delete(recruiters).where(inArray(recruiters.id, ids));
  }
}

async function opportunities() {
  const db = await getDb();
  return db.query.recruiterOpportunities.findMany({
    where: eq(recruiterOpportunities.userId, USER),
  });
}

async function main() {
  const db = await getDb();
  await cleanup();

  console.log("\nthe merge key");
  for (const [a, b] of [
    ["Stripe", "Stripe, Inc."],
    ["Stripe", "stripe"],
    ["Acme Co., Ltd.", "Acme"],
    ["The Hershey Company", "Hershey"],
    ["Datadog", "Datadog Inc"],
  ] as Array<[string, string]>) {
    check(
      `"${a}" and "${b}" are one company`,
      normalizeOpportunityCompany(a) === normalizeOpportunityCompany(b),
      `${normalizeOpportunityCompany(a)} vs ${normalizeOpportunityCompany(b)}`
    );
  }
  // Over-merging is worse than under-merging: two visibly-identical rows are a nuisance,
  // one row conflating two employers is wrong data.
  for (const [a, b] of [
    ["Stripe", "Stripe Labs"],
    ["Meta", "Meta Platforms"],
    ["Alpha Group", "Alpha"],
  ] as Array<[string, string]>) {
    check(
      `"${a}" and "${b}" stay distinct`,
      normalizeOpportunityCompany(a) !== normalizeOpportunityCompany(b),
      `both normalize to ${normalizeOpportunityCompany(a)}`
    );
  }

  console.log("\ncompany merging");
  await applyThreadFinding(USER, finding({ gmailThreadId: "t1", hiringCompany: "Stripe" }));
  await applyThreadFinding(
    USER,
    finding({
      gmailThreadId: "t2",
      hiringCompany: "Stripe, Inc.",
      correspondentEmail: "coordinator@stripe.com",
      correspondentName: "Dana Coordinator",
      stage: "screening",
      roles: ["Infrastructure Engineer"],
      firstMessageAt: d(5),
      lastMessageAt: d(5),
    })
  );
  let opps = await opportunities();
  check("two threads at one company make one process", opps.length === 1, `${opps.length}`);
  check("the process carries both threads", opps[0]?.threadCount === 2, `${opps[0]?.threadCount}`);
  check(
    "roles from both threads are kept",
    (opps[0]?.roles ?? []).length === 2,
    JSON.stringify(opps[0]?.roles)
  );
  check("the later stage wins", opps[0]?.stage === "screening", opps[0]?.stage);
  check(
    "both correspondents are saved as separate recruiters",
    (await db.query.userRecruiterLinks.findMany({ where: eq(userRecruiterLinks.userId, USER) }))
      .length === 2
  );

  console.log("\nstage monotonicity through the apply path");
  await applyThreadFinding(
    USER,
    finding({
      gmailThreadId: "t3",
      hiringCompany: "Stripe",
      stage: "applied",
      firstMessageAt: d(2),
      lastMessageAt: d(2),
    })
  );
  opps = await opportunities();
  check(
    "re-reading older mail does not drag the stage backwards",
    opps[0]?.stage === "screening",
    opps[0]?.stage
  );

  await applyThreadFinding(
    USER,
    finding({
      gmailThreadId: "t4",
      hiringCompany: "Stripe",
      stage: "rejected",
      stageEvidence: "we will not be moving forward",
      firstMessageAt: d(20),
      lastMessageAt: d(20),
    })
  );
  opps = await opportunities();
  check("a later rejection wins", opps[0]?.stage === "rejected", opps[0]?.stage);
  check(
    "the evidence shown describes the stage now displayed",
    opps[0]?.stageEvidence === "we will not be moving forward",
    opps[0]?.stageEvidence ?? "null"
  );

  console.log("\nidempotency — an incremental scan re-reads overlapping mail by design");
  const before = await opportunities();
  await applyThreadFinding(USER, finding({ gmailThreadId: "t1", hiringCompany: "Stripe" }));
  await applyThreadFinding(USER, finding({ gmailThreadId: "t1", hiringCompany: "Stripe" }));
  const after = await opportunities();
  check("re-applying a thread creates no second process", after.length === before.length);
  check(
    "and no second thread row",
    after[0]?.threadCount === before[0]?.threadCount,
    `${before[0]?.threadCount} -> ${after[0]?.threadCount}`
  );
  const threadRows = await db.query.recruiterThreads.findMany({
    where: and(eq(recruiterThreads.userId, USER), eq(recruiterThreads.gmailThreadId, "t1")),
  });
  check("exactly one row per Gmail thread", threadRows.length === 1, `${threadRows.length}`);

  console.log("\nATS findings contribute a stage but never a contact");
  const linksBefore = (
    await db.query.userRecruiterLinks.findMany({ where: eq(userRecruiterLinks.userId, USER) })
  ).length;
  await applyThreadFinding(
    USER,
    finding({
      gmailThreadId: "t-ats",
      senderKind: "ats",
      correspondentEmail: null,
      correspondentName: null,
      hiringCompany: "Datadog",
      stage: "applied",
    })
  );
  const linksAfter = (
    await db.query.userRecruiterLinks.findMany({ where: eq(userRecruiterLinks.userId, USER) })
  ).length;
  check("no recruiter contact is created for automated mail", linksAfter === linksBefore);
  check(
    "but the opportunity is",
    (await opportunities()).some((o) => o.companyNormalized.includes("datadog"))
  );

  console.log("\nhybrid write policy");
  await recordFinding(
    USER,
    null,
    finding({ gmailThreadId: "t-auto", hiringCompany: "Vercel", confidence: 0.95 }),
    { autoApply: true }
  );
  await recordFinding(
    USER,
    null,
    finding({
      gmailThreadId: "t-queued",
      hiringCompany: "Linear",
      correspondentEmail: "unsure@linear.app",
      confidence: 0.7,
    }),
    { autoApply: false }
  );

  const findings = await db.query.recruiterScanFindings.findMany({
    where: eq(recruiterScanFindings.userId, USER),
  });
  check(
    "an applied finding is still recorded, so the write is auditable",
    findings.some((f) => f.gmailThreadId === "t-auto" && f.status === "auto_applied")
  );
  check(
    "a queued finding is pending",
    findings.some((f) => f.gmailThreadId === "t-queued" && f.status === "pending")
  );
  const opps2 = await opportunities();
  check(
    "the applied finding created its process",
    opps2.some((o) => o.companyNormalized.includes("vercel"))
  );
  check(
    "the queued finding touched nothing but the queue",
    !opps2.some((o) => o.companyNormalized.includes("linear")),
    JSON.stringify(opps2.map((o) => o.companyNormalized))
  );
  check(
    "and created no contact",
    !(
      await db.query.userRecruiterLinks.findMany({ where: eq(userRecruiterLinks.userId, USER) })
    ).length ||
      !(await db.query.recruiters.findMany({ where: eq(recruiters.email, "unsure@linear.app") }))
        .length
  );

  console.log("\nverdict cache");
  await recordVerdict(USER, "Spam.Recruiter@Example.COM", "not_recruiter", 0.2);
  let verdicts = await loadVerdicts(USER);
  check(
    "verdicts are stored case-insensitively",
    verdicts.get("spam.recruiter@example.com") === "not_recruiter",
    JSON.stringify([...verdicts])
  );
  check("applying a human finding remembers them as a recruiter", verdicts.get("sarah@stripe.com") === "recruiter");
  await recordVerdict(USER, "spam.recruiter@example.com", "recruiter", 0.9);
  verdicts = await loadVerdicts(USER);
  check("a verdict can be revised, not duplicated", verdicts.get("spam.recruiter@example.com") === "recruiter");
  const verdictRows = await db.query.recruiterScanVerdicts.findMany({
    where: eq(recruiterScanVerdicts.userId, USER),
  });
  check(
    "one verdict row per sender",
    verdictRows.filter((v) => v.emailNormalized === "spam.recruiter@example.com").length === 1
  );

  console.log("\nno company, no process");
  await applyThreadFinding(
    USER,
    finding({
      gmailThreadId: "t-nocompany",
      hiringCompany: null,
      recruiterFirm: null,
      correspondentEmail: "mystery@unknown.example",
      correspondentName: "Mystery Person",
    })
  );
  const orphan = await db.query.recruiterThreads.findFirst({
    where: and(
      eq(recruiterThreads.userId, USER),
      eq(recruiterThreads.gmailThreadId, "t-nocompany")
    ),
  });
  check("the thread is still recorded", Boolean(orphan));
  check("but attached to no process rather than a guessed one", orphan?.opportunityId === null);
}

main()
  .then(async () => {
    await cleanup();
    if (failures > 0) {
      console.log(`\n${failures} pipeline check(s) failed`);
      process.exit(1);
    }
    console.log("\nall recruiter pipeline checks passed");
    process.exit(0);
  })
  .catch(async (err) => {
    await cleanup().catch(() => {});
    console.error(err);
    process.exit(1);
  });
