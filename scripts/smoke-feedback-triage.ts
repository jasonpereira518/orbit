/**
 * Feedback triage + Slack DM smoke tests.
 *
 * `parseTriage` is the boundary between what a model said about a report and what Orbit
 * stores and links to: a made-up kind, a severity outside the list or a "duplicate" the model
 * was never shown must not reach the console. `buildFeedbackDm` is what lands in Slack, and
 * the report inside it is user-written, so Slack markup in it has to arrive as text.
 *
 * No database, no network, no model call.
 *
 * Run: npx tsx scripts/smoke-feedback-triage.ts
 */
import { DM_TEXT_MAX, buildFeedbackDm, type SubmittedFeedback } from "../src/lib/feedback-notify";
import { TRIAGE_SUMMARY_MAX, parseTriage, triageFeedback } from "../src/lib/feedback-triage";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

const EARLIER = "11111111-1111-4111-8111-111111111111";
const known = new Set([EARLIER]);

async function main() {
  console.log("parseTriage");
  {
    const ok = parseTriage(
      { summary: "Search misses names with accents", category: "bug", severity: "medium", duplicateOf: EARLIER },
      known
    );
    check("a well-formed answer is kept", ok?.summary === "Search misses names with accents" && ok.category === "bug" && ok.severity === "medium");
    check("a duplicate the model was shown is kept", ok?.duplicateOf === EARLIER);

    const foreign = parseTriage(
      { summary: "x", category: "idea", severity: "low", duplicateOf: "22222222-2222-4222-8222-222222222222" },
      known
    );
    check("a duplicate the model was NOT shown is dropped", foreign !== null && foreign.duplicateOf === null);

    check("a made-up kind is rejected", parseTriage({ summary: "x", category: "rant", severity: "low" }, known) === null);
    check("a made-up severity is rejected", parseTriage({ summary: "x", category: "bug", severity: "urgent" }, known) === null);
    check("an empty summary is rejected", parseTriage({ summary: "  ", category: "bug", severity: "low" }, known) === null);
    check("a non-object is rejected", parseTriage("bug", known) === null && parseTriage(null, known) === null);

    const long = parseTriage({ summary: "a ".repeat(200), category: "bug", severity: "low", duplicateOf: null }, known);
    check(
      `an over-long summary is cut to ${TRIAGE_SUMMARY_MAX} with an ellipsis`,
      long !== null && long.summary.length <= TRIAGE_SUMMARY_MAX && long.summary.endsWith("…"),
      long?.summary
    );
    const lines = parseTriage({ summary: "one\n\ntwo", category: "praise", severity: "low" }, known);
    check("a multi-line summary becomes one line", lines?.summary === "one two");
    check("a missing duplicateOf reads as none", lines?.duplicateOf === null);
  }

  console.log("\ntriageFeedback");
  {
    const before = process.env.ADMIN_USER_IDS;
    process.env.ADMIN_USER_IDS = "";
    check("no operator configured: skips without touching the database", (await triageFeedback("anything")) === null);
    process.env.ADMIN_USER_IDS = before;
  }

  console.log("\nbuildFeedbackDm");
  {
    const now = new Date("2026-11-09T12:00:00Z");
    const base: SubmittedFeedback = {
      id: "f-1",
      userId: "u-1",
      plan: "orbit",
      area: "contacts",
      category: "bug",
      text: "Search is broken <!channel> & stuff\nsecond line",
      path: "/contacts?q=jos%C3%A9",
      screenshotCount: 2,
      triage: { summary: "Search <b>misses</b> accents", severity: "high", duplicateOf: EARLIER },
    };
    const dm = buildFeedbackDm(base, { email: "jane@example.com", joinedAt: new Date("2026-10-17T12:00:00Z") }, "https://orbit.test", now);
    const [headline, who] = dm.split("\n");
    check("the headline leads with kind, severity and the summary", headline === ":speech_balloon: *bug · high* — Search &lt;b&gt;misses&lt;/b&gt; accents", headline);
    check("the who-line names the sender, plan, age, page and shots", /^From jane@example\.com · .+ · member 23 days · on \/contacts\?q=jos%C3%A9 · 2 screenshots$/.test(who), who);
    check("Slack markup in the report arrives as text", dm.includes("&lt;!channel&gt; &amp; stuff") && !dm.includes("<!channel>"));
    check("every line of the report is quoted", dm.includes("> Search is broken") && dm.includes("> second line"));
    check("a repeat links the earlier report", dm.includes(`Looks like an earlier report: https://orbit.test/admin/feedback/${EARLIER}`));
    check("the last line is the report's own link", dm.endsWith("https://orbit.test/admin/feedback/f-1"));

    const bare = buildFeedbackDm(
      { ...base, category: null, plan: null, path: null, screenshotCount: 0, triage: null, text: "x".repeat(DM_TEXT_MAX + 50) },
      { email: null, joinedAt: now },
      "https://orbit.test",
      now
    );
    check("no triage and no kind still reads as feedback", bare.startsWith(":speech_balloon: *New feedback*\n"));
    check("an unknown sender is said plainly, and a same-day account reads as new", bare.includes("From an unknown account · joined today · in contacts"));
    check(`the report is clipped at ${DM_TEXT_MAX} characters`, bare.includes(`> ${"x".repeat(DM_TEXT_MAX)}…`) && !bare.includes("x".repeat(DM_TEXT_MAX + 1)));
    check("no repeat, no repeat line", !bare.includes("Looks like"));
  }

  console.log("\nAll feedback triage checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
