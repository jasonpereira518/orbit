/**
 * The Outreach pages and the new-campaign form: what they must keep doing, read from source.
 *
 * Pure and structural, like smoke-events-page. A page that forgets its gate, or an action that
 * quietly grows an LLM call again, would degrade without any test going red, so each rule is
 * pinned here:
 *
 *   - every page under /outreach awaits `pageVisibilityGate("page.outreach")` before anything
 *     else, in its DEFAULT export (`[id]/page.tsx`'s `generateMetadata` awaits earlier, and
 *     that is fine);
 *   - `createCampaign` takes no model call and is a guarded, wrapped action;
 *   - the form is a client component that never reaches the database.
 *
 * Run: npx tsx scripts/smoke-outreach-page.ts
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  OUTREACH_REPLY_CTAS,
  OUTREACH_TONES,
  REPLY_CTA_LABELS,
} from "../src/lib/outreach-types";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** A module with its comments stripped, so prose describing a rule is not read as code. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

/** From `marker` to the next top-level declaration (column 0), exclusive. */
function declaration(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const rest = source.slice(start + marker.length);
  const next = rest.search(/\n(?=(?:export |async function |function |const |let |type )\b)/);
  return source.slice(start, next < 0 ? undefined : start + marker.length + next);
}

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pages(path);
    return name === "page.tsx" ? [path] : [];
  });
}

const OUTREACH_DIR = "src/app/(clerk)/(app)/(main)/outreach";

function main() {
  console.log("\nthe pages are gated, in order");
  {
    const files = pages(OUTREACH_DIR);
    check("finds the outreach pages", files.length >= 3, files.join(", "));
    for (const file of files) {
      const source = code(file);
      const at = source.indexOf("export default async function");
      const body = at < 0 ? "" : source.slice(at);
      const label = file.slice(OUTREACH_DIR.length);
      check(`${label} has a default async page`, at >= 0);
      const firstAwait = body.match(/await\s+([^;]*)/)?.[1]?.trim() ?? "";
      check(
        `${label} awaits the visibility gate first`,
        firstAwait === 'pageVisibilityGate("page.outreach")',
        firstAwait
      );
      const entitlement = body.indexOf("canUseOutreach");
      check(
        `${label} checks the plan after the gate`,
        entitlement > body.indexOf("pageVisibilityGate"),
        "canUseOutreach must come after the gate"
      );
      check(`${label} renders the stamp`, body.includes("<RenderStamp />"));
    }
  }

  console.log("\nnew campaign page");
  {
    const page = code(`${OUTREACH_DIR}/new/page.tsx`);
    check("renders the new form", /import\s*\{\s*NewCampaignForm\s*\}\s*from/.test(page) && page.includes("<NewCampaignForm"));
    check("and not the wizard", !page.includes("OutreachWizard"));
    check("the wizard file is gone", !existsSync("src/components/outreach/outreach-wizard.tsx"));
  }

  console.log("\ncreateCampaign");
  {
    const actions = code("src/actions/outreach.ts");
    const body = declaration(actions, "export async function createCampaign");
    check("is found", body.length > 0);
    check("takes no model call", !body.includes("parseAudienceToFilters"));
    check("is wrapped, so a refusal reaches the form as data", body.includes("asActionResult"));
    const guard = body.indexOf("requireOutreachUser()");
    check("checks the plan before anything else", guard > 0 && !body.slice(0, guard).includes("getDb"));
    check("bounds the audience at 3 to 300", /audienceQuery[\s\S]*?\b3\b[\s\S]*?\b300\b/.test(body));
    check("bounds the reason at 3 to 1000", /messageIntent[\s\S]*?\b3\b[\s\S]*?(?:1000|1_000)\b/.test(body));
    check("names the campaign from the audience, cut to 60", /slice\(0,\s*60\)/.test(body));
    check("returns the id", /\{\s*id:/.test(body));
  }

  console.log("\nthe form");
  {
    const file = "src/components/outreach/new-campaign-form.tsx";
    const source = code(file);
    check('is a client component', readFileSync(file, "utf8").startsWith('"use client"'));
    check("never value-imports the database", !/import\s+(?!type\b)[^;]*from\s+["']@\/db/.test(source));
    check("calls createCampaign and goes to the campaign", source.includes("createCampaign(") && /router\.push\(`\/outreach\/\$\{/.test(source));
    check("shows a refusal inline, not only in a toast", source.includes("<FormError"));
    check("the asks are a radio group", source.includes('role="radiogroup"') && source.includes('type="radio"'));
    check("the audience placeholder is the example", source.includes("UNC alumni doing health-economics consulting in RTP"));
    check("tones come from the shared list", source.includes("OUTREACH_TONES"));
    check("the name sits under a disclosure", source.includes("<details") && source.includes("<summary"));
    check("no escaped apostrophes", !/\\u2019|&rsquo;|&#8217;/.test(source));
  }

  console.log("\nlabels and copy");
  {
    check("every ask has a label", OUTREACH_REPLY_CTAS.every((k) => REPLY_CTA_LABELS[k]));
    check("book_intro reads A short chat", REPLY_CTA_LABELS.book_intro === "A short chat");
    check("ask_referral reads A referral", REPLY_CTA_LABELS.ask_referral === "A referral");
    check("get_feedback reads Advice on a question", REPLY_CTA_LABELS.get_feedback === "Advice on a question");
    check(
      "explore_partnership reads Exploring working together",
      REPLY_CTA_LABELS.explore_partnership === "Exploring working together"
    );
    check("other reads Something else", REPLY_CTA_LABELS.other === "Something else");
    check("there is a default tone to start from", OUTREACH_TONES.includes("professional"));

    const layout = code(`${OUTREACH_DIR}/layout.tsx`);
    check("the locked copy no longer sells SMS or Apollo", !/\bSMS\b|Apollo/i.test(layout));

    const list = code(`${OUTREACH_DIR}/page.tsx`);
    check(
      "the list header says who this is for",
      list.includes("Reach people you don’t know yet — from your own email"),
    );

    const card = code("src/components/outreach/outreach-campaign-card.tsx");
    check("the card shows the reply rate", /formatReplyRate\([^)]*replyRate\)/.test(card));
    check("and the channel, people, sent and replied", /defaultChannel/.test(card) && /prospectCount/.test(card) && /sentCount/.test(card) && /replyCount/.test(card));
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll outreach page checks passed.");
}

main();
