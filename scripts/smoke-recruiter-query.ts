/**
 * Exercises the Gmail discovery query builder — the cheapest and highest-leverage part of
 * the recruiter scan. Every clause here is work Gmail does for free that would otherwise
 * become a metadata fetch and, past the prefilter, an LLM call on the user's own API key.
 *
 * No DB and no network. The watermark logic that feeds `after:` needs a database and is
 * covered by scripts/smoke-recruiter-scan-state.ts.
 *
 * Run: npx tsx scripts/smoke-recruiter-query.ts
 */
import {
  ATS_SENDER_DOMAINS,
  EXCLUDED_JOB_BOARD_DOMAINS,
  RECRUITER_QUERY_EXCLUSIONS,
  RECRUITER_QUERY_TERMS,
  RECRUITER_SENT_QUERY_EXCLUSIONS,
  RECRUITER_SENT_QUERY_TERMS,
  buildRecruiterQuery,
} from "../src/lib/gmail";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) {
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  console.log(`  ok  ${label}`);
}

console.log("\nwindow bound");
const after = new Date(Date.UTC(2024, 8, 5)); // 2024-09-05
const bounded = buildRecruiterQuery({ after });
check("emits Gmail's YYYY/M/D date form", bounded.includes("after:2024/9/5"), bounded);
check(
  "an unbounded call omits the clause entirely rather than sending a sentinel date",
  !buildRecruiterQuery().includes("after:")
);

console.log("\nexclusions are never optional");
for (const query of [buildRecruiterQuery(), buildRecruiterQuery({ after })]) {
  for (const clause of RECRUITER_QUERY_EXCLUSIONS) {
    check(`inbound carries "${clause.slice(0, 22)}…"`, query.includes(clause), query);
  }
}
for (const query of [
  buildRecruiterQuery({ direction: "sent" }),
  buildRecruiterQuery({ after, direction: "sent" }),
]) {
  for (const clause of RECRUITER_SENT_QUERY_EXCLUSIONS) {
    check(`sent carries "${clause.slice(0, 22)}…"`, query.includes(clause), query);
  }
}

console.log("\njob boards are subtracted server-side");
const inboundExclusions = RECRUITER_QUERY_EXCLUSIONS.join(" ");
const sentExclusions = RECRUITER_SENT_QUERY_EXCLUSIONS.join(" ");
for (const domain of EXCLUDED_JOB_BOARD_DOMAINS) {
  check(`${domain} excluded inbound`, inboundExclusions.includes(domain));
  check(`${domain} excluded outbound`, sentExclusions.includes(domain));
}
check(
  "promotions and social tabs excluded inbound",
  inboundExclusions.includes("-category:promotions") &&
    inboundExclusions.includes("-category:social")
);

console.log("\nATS mail is KEPT inbound — it carries the stage history");
// Verified against a real mailbox: excluding these dropped rejections, assessment
// invitations, and application-received events, which is most of the pipeline.
for (const domain of ATS_SENDER_DOMAINS) {
  check(
    `${domain} survives the inbound query`,
    !inboundExclusions.includes(domain),
    inboundExclusions
  );
}
check(
  "automated senders are not excluded inbound",
  !/-from:\(noreply/.test(inboundExclusions),
  inboundExclusions
);
check(
  "but ATS addresses are excluded as outbound recipients",
  ATS_SENDER_DOMAINS.every((d) => sentExclusions.includes(d))
);

console.log("\ndirection-correct exclusion operators");
// In `in:sent` the sender is always the user, so a -from: domain clause matches nothing.
// This is the assertion that keeps the outbound sweep from only appearing to filter.
check(
  "outbound subtracts by recipient, not sender",
  sentExclusions.includes("-to:") && !sentExclusions.includes("-from:"),
  sentExclusions
);
check(
  "inbound subtracts by sender",
  inboundExclusions.includes("-from:"),
  inboundExclusions
);
check(
  "inbox-only category filters are not carried into the sent arm",
  !sentExclusions.includes("-category:")
);

console.log("\ndirection");
const inbound = buildRecruiterQuery({ after });
const sent = buildRecruiterQuery({ after, direction: "sent" });
check("inbound does not constrain to the sent mailbox", !inbound.includes("in:sent"));
check("sent arm constrains to the sent mailbox", sent.includes("in:sent"));
check("inbound uses the inbound term set", inbound.includes(RECRUITER_QUERY_TERMS));
check("sent uses its own narrower term set", sent.includes(RECRUITER_SENT_QUERY_TERMS));

console.log("\nshape");
check("no doubled whitespace", !/ {2}/.test(bounded), bounded);
check("balanced parens", (bounded.match(/\(/g) || []).length === (bounded.match(/\)/g) || []).length);

console.log("\nall recruiter query checks passed");
